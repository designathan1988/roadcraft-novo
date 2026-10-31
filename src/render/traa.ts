// @ts-nocheck
// Copy of three r186's TRAANode (examples/jsm/tsl/display) with the previous-depth fix.
//
// three's `samplePreviousDepth` (TAAUtils) receives the camera as an argument of a TSL Fn: inside it becomes
// a node proxy and `camera.isOrthographicCamera` is also true for the perspective camera. The previous depth came out
// converted as orthographic (~0.006 instead of ~0.9994), TRAA saw "disocclusion" on EVERY pixel and threw away the
// history: each frame came out raw, with the ±½ pixel jitter, and the whole image shook while still (the "camera
// shake"). Here the reprojection is done outside the Fn, with the camera type in a uniform (perspective/isometric switch).
import { HalfFloatType, NoBlending, Vector2, RenderTarget, RendererUtils, QuadMesh, NodeMaterial, TempNode, NodeUpdateType, Matrix4, DepthTexture, FloatType } from 'three/webgpu';
import { float, Fn, max, floor, texture, uniform, uv, vec2, vec4, convertToTexture, passTexture, velocity, ivec2, mix, context, getViewPosition, viewZToPerspectiveDepth, viewZToOrthographicDepth, OnBeforeRenderPipeline, OnAfterRenderPipeline } from 'three/tsl';
import { clipAABB, computeHaltonOffsets, flickerReduction, sampleCurrentDepth } from 'three/addons/tsl/utils/TAAUtils.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
/** 1 = shows the history validity and the current frame's weight. */
export const traaDebug = /*@__PURE__*/ uniform( 0 );
const _size = /*@__PURE__*/ new Vector2();

/**
 * The least weight of the current frame where the surface itself moved (a walker, a vehicle; velocity z, see
 * render/velocity.ts). Exponential smoothing with weight α gathers (2 − α) / α samples a pixel at best (Yang et al. 2009,
 * eq. 30; the TAA survey of Yang, Liu and Salvi 2020, fig. 4): 0.4 gives 4, the samples Roadcraft 4.0 gives every pixel
 * of its image (MSAA 4×, r40 quality.ts). A small figure 3 to 5 pixels wide is all edge: its 3×3 neighbourhood holds the
 * pavement too, the colour box the history is clipped to spans both and let older poses through at 86–95 % a frame
 * (the survey's §6.2, fig. 10: "a running character leaves a ghosting trail"); Unreal Engine 4 and Uncharted 4 raise
 * the weight on such pixels through a mask (the velocity is read at the nearest texel of the 3×3, so this mask is
 * dilated by a pixel as Uncharted 4's).
 */
export const MOVER_WEIGHT = 0.4;

/**
 * The Catmull-Rom spline's weights for the four texels round a point a fraction `f` past the second (texels at −1, 0,
 * 1, 2 from it), on anything with mul/add/sub (TSL nodes; numbers wrapped in the tests): the middle two are both
 * positive for f in [0, 1], so one bilinear read between them carries both (vec3.ca, "bicubic filtering in fewer
 * taps"; MJP's 9-tap Catmull-Rom). Returns the weights of the outer texels, of the middle pair, and where in the pair
 * (0..1 past the second texel) the bilinear read lands.
 */
export function catmullRomTaps( f ) {

	const w0 = f.mul( f.mul( f.mul( - 0.5 ).add( 1 ) ).sub( 0.5 ) );
	const w1 = f.mul( f ).mul( f.mul( 1.5 ).sub( 2.5 ) ).add( 1 );
	const w2 = f.mul( f.mul( f.mul( - 1.5 ).add( 2 ) ).add( 0.5 ) );
	const w3 = f.mul( f ).mul( f.mul( 0.5 ).sub( 0.5 ) );
	const w12 = w1.add( w2 );
	return { w0, w12, w3, at12: w2.div( w12 ) };

}

let _rendererState;


/**
 * A special node that applies TRAA (Temporal Reprojection Anti-Aliasing).
 *
 * References:
 * - {@link https://alextardif.com/TAA.html}
 * - {@link https://www.elopezr.com/temporal-aa-and-the-quest-for-the-holy-trail/}
 *
 * Note: MSAA must be disabled when TRAA is in use.
 *
 * @augments TempNode
 * @three_import import { traa } from 'three/addons/tsl/display/TRAANode.js';
 */
class TRAANode extends TempNode {

	static get type() {

		return 'TRAANode';

	}

	/**
	 * Constructs a new TRAA node.
	 *
	 * @param {TextureNode} beautyNode - The texture node that represents the input of the effect.
	 * @param {TextureNode} depthNode - A node that represents the scene's depth.
	 * @param {TextureNode} velocityNode - A node that represents the scene's velocity.
	 * @param {Camera} camera - The camera the scene is rendered with.
	 */
	constructor( beautyNode, depthNode, velocityNode, camera ) {

		super( 'vec4' );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isTRAANode = true;

		/**
		 * The `updateBeforeType` is set to `NodeUpdateType.FRAME` since the node renders
		 * its effect once per frame in `updateBefore()`.
		 *
		 * @type {string}
		 * @default 'frame'
		 */
		this.updateBeforeType = NodeUpdateType.FRAME;

		/**
		 * The texture node that represents the input of the effect.
		 *
		 * @type {TextureNode}
		 */
		this.beautyNode = beautyNode;

		/**
		 * A node that represents the scene's velocity.
		 *
		 * @type {TextureNode}
		 */
		this.depthNode = depthNode;

		/**
		 * A node that represents the scene's velocity.
		 *
		 * @type {TextureNode}
		 */
		this.velocityNode = velocityNode;

		/**
		 * The camera the scene is rendered with.
		 *
		 * @type {Camera}
		 */
		this.camera = camera;

		/**
		 * When the difference between the current and previous depth goes above this threshold,
		 * the history is considered invalid.
		 *
		 * @type {number}
		 * @default 0.0005
		 */
		this.depthThreshold = 0.0005;

		/**
		 * The depth difference within the 3×3 neighborhood to consider a pixel as an edge.
		 *
		 * @type {number}
		 * @default 0.001
		 */
		this.edgeDepthDiff = 0.001;

		/**
		 * The history becomes invalid as the pixel length of the velocity approaches this value.
		 *
		 * @type {number}
		 * @default 128
		 */
		this.maxVelocityLength = 128;

		/**
		 * Whether to decrease the weight on the current frame when the velocity is more subpixel.
		 * This reduces blurriness under motion, but can introduce a square pattern artifact.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.useSubpixelCorrection = true;

		/**
		 * The jitter index selects the current camera offset value.
		 *
		 * @private
		 * @type {number}
		 * @default 0
		 */
		this._jitterIndex = 0;

		/**
		 * A uniform node holding the inverse resolution value.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._invSize = uniform( new Vector2() );

		/**
		 * The render target that represents the history of frame data.
		 *
		 * @private
		 * @type {?RenderTarget}
		 */
		/**
		 * Set to start the history again from the current frame (next update).
		 *
		 * @type {boolean}
		 */
		this.restartHistory = false;

		this._historyRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType, depthTexture: new DepthTexture() } );
		this._historyRenderTarget.texture.name = 'TRAANode.history';

		/**
		 * The render target for the resolve.
		 *
		 * @private
		 * @type {?RenderTarget}
		 */
		this._resolveRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );
		this._resolveRenderTarget.texture.name = 'TRAANode.resolve';

		/**
		 * Material used for the resolve step.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._resolveMaterial = new NodeMaterial();
		this._resolveMaterial.name = 'TRAA.resolve';
		// written as it is, alpha included (the history's motion memory): with NormalBlending an opaque node material's
		// alpha is forced to 1 (three r186 NodeBuilder.isOpaque, NodeMaterial setupOutput)
		this._resolveMaterial.blending = NoBlending;

		/**
		 * The result of the effect is represented as a separate texture node.
		 *
		 * @private
		 * @type {PassTextureNode}
		 */
		this._textureNode = passTexture( this, this._resolveRenderTarget.texture );

		/**
		 * Used to save the original/unjittered projection matrix.
		 *
		 * @private
		 * @type {Matrix4}
		 */
		this._originalProjectionMatrix = new Matrix4();

		/**
		 * A uniform node holding the camera's near and far.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._cameraNearFar = uniform( new Vector2() );

		/** 1 = orthographic (isometric) camera. */
		this._cameraOrtho = uniform( 0 );

		/**
		 * A uniform node holding the camera world matrix.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraWorldMatrix = uniform( new Matrix4() );

		/**
		 * A uniform node holding the camera world matrix inverse.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraWorldMatrixInverse = uniform( new Matrix4() );

		/**
		 * A uniform node holding the camera projection matrix inverse.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraProjectionMatrixInverse = uniform( new Matrix4() );

		/**
		 * A uniform node holding the previous frame's view matrix.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._previousCameraWorldMatrix = uniform( new Matrix4() );

		/**
		 * A uniform node holding the previous frame's projection matrix inverse.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._previousCameraProjectionMatrixInverse = uniform( new Matrix4() );

		/**
		 * A texture node for the previous depth buffer.
		 *
		 * @private
		 * @type {TextureNode}
		 */
		this._previousDepthNode = texture( new DepthTexture( 1, 1 ) );

		/**
		 * Sync the post processing stack with the TRAA node.
		 *
		 * @private
		 * @type {boolean}
		 */
		this._needsPostProcessingSync = false;

		/**
		 * The node used to render the scene's velocity.
		 *
		 * @private
		 * @type {?VelocityNode}
		 */
		this._velocityNode = null;

	}

	/**
	 * Returns the result of the effect as a texture node.
	 *
	 * @return {PassTextureNode} A texture node that represents the result of the effect.
	 */
	getTextureNode() {

		return this._textureNode;

	}

	/**
	 * Sets the size of the effect.
	 *
	 * @param {number} width - The width of the effect.
	 * @param {number} height - The height of the effect.
	 */
	setSize( width, height ) {

		this._historyRenderTarget.setSize( width, height );
		this._resolveRenderTarget.setSize( width, height );

		this._invSize.value.set( 1 / width, 1 / height );

	}

	/**
	 * Defines the TRAA's current jitter as a view offset
	 * to the scene's camera.
	 *
	 * @param {number} width - The width of the effect.
	 * @param {number} height - The height of the effect.
	 */
	setViewOffset( width, height ) {

		// save original/unjittered projection matrix for velocity pass

		this.camera.updateProjectionMatrix();
		this._originalProjectionMatrix.copy( this.camera.projectionMatrix );

		this._velocityNode.setProjectionMatrix( this._originalProjectionMatrix );

		//

		const viewOffset = {

			fullWidth: width,
			fullHeight: height,
			offsetX: 0,
			offsetY: 0,
			width: width,
			height: height

		};

		const jitterOffset = _haltonOffsets[ this._jitterIndex ];

		this.camera.setViewOffset(

			viewOffset.fullWidth, viewOffset.fullHeight,

			viewOffset.offsetX + jitterOffset[ 0 ] - 0.5, viewOffset.offsetY + jitterOffset[ 1 ] - 0.5,

			viewOffset.width, viewOffset.height

		);

	}

	/**
	 * Clears the view offset from the scene's camera.
	 */
	clearViewOffset() {

		this.camera.clearViewOffset();

		this._velocityNode.setProjectionMatrix( null );

		// update jitter index

		this._jitterIndex ++;
		this._jitterIndex = this._jitterIndex % _haltonOffsets.length;

	}

	/**
	 * This method is used to render the effect once per frame.
	 *
	 * @param {NodeFrame} frame - The current node frame.
	 */
	updateBefore( frame ) {

		const { renderer } = frame;

		// store previous frame matrices before updating current ones

		this._previousCameraWorldMatrix.value.copy( this._cameraWorldMatrix.value );
		this._previousCameraProjectionMatrixInverse.value.copy( this._cameraProjectionMatrixInverse.value );

		// update camera matrices uniforms

		this._cameraNearFar.value.set( this.camera.near, this.camera.far );
		this._cameraOrtho.value = this.camera.isOrthographicCamera ? 1 : 0;
		this._cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this._cameraWorldMatrixInverse.value.copy( this.camera.matrixWorldInverse );
		this._cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

		// keep the TRAA in sync with the dimensions of the beauty node

		const beautyRenderTarget = ( this.beautyNode.isRTTNode ) ? this.beautyNode.renderTarget : this.beautyNode.passNode.renderTarget;

		const width = beautyRenderTarget.texture.width;
		const height = beautyRenderTarget.texture.height;

		//

		if ( this._needsPostProcessingSync === true ) {

			this.setViewOffset( width, height );

			this._needsPostProcessingSync = false;

		}

		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		//

		// a restart asked from outside (the final image switched to this TRAA's output after a while away)
		const needsRestart = this.restartHistory === true || this._historyRenderTarget.width !== width || this._historyRenderTarget.height !== height;
		this.restartHistory = false;
		this.setSize( width, height );

		// every time when the dimensions change we need fresh history data

		if ( needsRestart === true ) {

			// make sure render targets are initialized after the resize which triggers a dispose()

			renderer.initRenderTarget( this._historyRenderTarget );
			renderer.initRenderTarget( this._resolveRenderTarget );

			// make sure to reset the history with the contents of the beauty buffer otherwise subsequent frames after the
			// resize will fade from a darker color to the correct one because the history was cleared with black.

			renderer.copyTextureToTexture( beautyRenderTarget.texture, this._historyRenderTarget.texture );

		}

		// resolve

		renderer.setRenderTarget( this._resolveRenderTarget );
		_quadMesh.material = this._resolveMaterial;
		_quadMesh.name = 'TRAA';
		_quadMesh.render( renderer );
		renderer.setRenderTarget( null );

		// update history

		renderer.copyTextureToTexture( this._resolveRenderTarget.texture, this._historyRenderTarget.texture );

		// Copy current depth to previous depth buffer

		const size = renderer.getDrawingBufferSize( _size );

		// only allow the depth copy if the dimensions of the history render target match with the drawing
		// render buffer and thus the depth texture of the scene. For some reasons, there are timing issues
		// with WebGPU resulting in different size of the drawing buffer and the beauty render target when
		// resizing the browser window. This does not happen with the WebGL backend

		if ( this._historyRenderTarget.height === size.height && this._historyRenderTarget.width === size.width ) {

			const currentDepth = this.depthNode.value;
			renderer.copyTextureToTexture( currentDepth, this._historyRenderTarget.depthTexture );
			this._previousDepthNode.value = this._historyRenderTarget.depthTexture;

		}

		// restore

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	/**
	 * This method is used to setup the effect's render targets and TSL code.
	 *
	 * @param {NodeBuilder} builder - The current node builder.
	 * @return {PassTextureNode}
	 */
	setup( builder ) {

		if ( builder.renderPipeline && ! builder.context.renderPipelineState.viewOffsetOwner ) {

			builder.context.renderPipelineState.viewOffsetOwner = this;

			this._needsPostProcessingSync = true;

			OnBeforeRenderPipeline( () => {

				const size = builder.renderer.getDrawingBufferSize( _size );
				this.setViewOffset( size.width, size.height );

			} );

			OnAfterRenderPipeline( () => {

				this.clearViewOffset();

			} );

		}

		if ( builder.renderer.reversedDepthBuffer === true ) {

			this._historyRenderTarget.depthTexture.type = FloatType;

		}

		if ( builder.context.velocity !== undefined ) {

			this._velocityNode = builder.context.velocity;

		} else {

			this._velocityNode = velocity;

		}

		// Performs variance clipping.
		// See: https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf
		const varianceClipping = Fn( ( [ positionTexel, currentColor, historyColor, gamma ] ) => {

			const offsets = [
				[ - 1, - 1 ],
				[ - 1, 1 ],
				[ 1, - 1 ],
				[ 1, 1 ],
				[ 1, 0 ],
				[ 0, - 1 ],
				[ 0, 1 ],
				[ - 1, 0 ]
			];

			const moment1 = currentColor.toVar();
			const moment2 = currentColor.pow2().toVar();

			for ( const [ x, y ] of offsets ) {

				// Use max() to prevent NaN values from propagating.
				const neighbor = this.beautyNode.offset( ivec2( x, y ) ).load( positionTexel ).max( 0 );
				moment1.addAssign( neighbor );
				moment2.addAssign( neighbor.pow2() );

			}

			const N = float( offsets.length + 1 );
			const mean = moment1.div( N );
			const variance = moment2.div( N ).sub( mean.pow2() ).max( 0 ).sqrt().mul( gamma );
			const minColor = mean.sub( variance );
			const maxColor = mean.add( variance );

			return clipAABB( mean.clamp( minColor, maxColor ), historyColor, minColor, maxColor );

		} );

		// The 3x3 neighbourhood's luma range in the current frame: a high-contrast thin line (a window's mullion, a
		// railing) lies across it.
		const lumaRange = Fn( ( [ positionTexel ] ) => {

			const lo = float( 1e9 ).toVar(), hi = float( 0 ).toVar();
			for ( let y = - 1; y <= 1; y ++ ) for ( let x = - 1; x <= 1; x ++ ) {

				const c = this.beautyNode.offset( ivec2( x, y ) ).load( positionTexel ).max( 0 );
				const l = c.r.mul( 0.2126 ).add( c.g.mul( 0.7152 ) ).add( c.b.mul( 0.0722 ) );
				lo.assign( lo.min( l ) ); hi.assign( hi.max( l ) );

			}

			return hi.sub( lo ).div( hi.add( 1e-4 ) );

		} );

		// Returns the amount of subpixel (expressed within [0, 1]) in the velocity.
		const subpixelCorrection = Fn( ( [ velocityUV, textureSize ] ) => {

			const velocityTexel = velocityUV.mul( textureSize );
			const phase = velocityTexel.fract().abs();
			const weight = max( phase, phase.oneMinus() );
			return weight.x.mul( weight.y ).oneMinus().div( 0.75 );

		} ).setLayout( {
			name: 'subpixelCorrection',
			type: 'float',
			inputs: [
				{ name: 'velocityUV', type: 'vec2' },
				{ name: 'textureSize', type: 'ivec2' }
			]
		} );

		const historyNode = texture( this._historyRenderTarget.texture );

		// The history at a point between texels, through the Catmull-Rom spline (9 bilinear reads). A bilinear read
		// softens what it reads, and the history is read again every frame it moves: the softening piles up (the TAA
		// survey's §6.1.1 "resampling blur"; walkers and anything the camera turns past went soft). Catmull-Rom keeps
		// the detail (the survey's fig. 8; Unreal Engine 4's TAA and SMAA T2x read the history so); where the history
		// lands on a texel (nothing moved) it reads that texel alone, as bilinear did. Its lobes can overshoot below 0.
		const sampleHistory = ( historyUV, textureSize ) => {

			const size = vec2( textureSize );
			const at = historyUV.mul( size );
			const t1 = floor( at.sub( 0.5 ) ).add( 0.5 );
			const { w0, w12, w3, at12 } = catmullRomTaps( at.sub( t1 ) );
			const xs = [ t1.x.sub( 1 ), t1.x.add( at12.x ), t1.x.add( 2 ) ], wx = [ w0.x, w12.x, w3.x ];
			const ys = [ t1.y.sub( 1 ), t1.y.add( at12.y ), t1.y.add( 2 ) ], wy = [ w0.y, w12.y, w3.y ];
			let sum = null;
			for ( let j = 0; j < 3; j ++ ) for ( let i = 0; i < 3; i ++ ) {

				const tap = historyNode.sample( vec2( xs[ i ], ys[ j ] ).div( size ) ).mul( wx[ i ].mul( wy[ j ] ) );
				sum = sum === null ? tap : sum.add( tap );

			}

			return vec4( sum.rgb.max( 0 ), sum.a.saturate() );

		};

		const resolve = Fn( () => {

			const uvNode = uv();
			const textureSize = this.beautyNode.size(); // Assumes all the buffers share the same size.
			const positionTexel = uvNode.mul( textureSize );

			// sample the closest and farthest depths in the current buffer

			const currentDepth = sampleCurrentDepth( this.depthNode, positionTexel, this._cameraNearFar );
			const closestDepth = currentDepth.get( 'closestDepth' );
			const closestPositionTexel = currentDepth.get( 'closestPositionTexel' );
			const farthestDepth = currentDepth.get( 'farthestDepth' );

			// convert the NDC offset to UV offset

			const velocityTexel = this.velocityNode.load( closestPositionTexel );
			const offsetUV = velocityTexel.xy.mul( vec2( 0.5, - 0.5 ) );
			// z = 1: the surface itself moved since the last frame (render/velocity.ts stableVelocity), however slowly
			const objectMoved = velocityTexel.z.greaterThan( 0.5 );

			// sample the previous depth

			const historyUV = uvNode.sub( offsetUV );
			const prevRaw = this._previousDepthNode.sample( historyUV ).r;
			const prevView = getViewPosition( historyUV, prevRaw, this._previousCameraProjectionMatrixInverse );
			const prevWorld = this._previousCameraWorldMatrix.mul( vec4( prevView, 1 ) ).xyz;
			const prevViewZ = this._cameraWorldMatrixInverse.mul( vec4( prevWorld, 1 ) ).z;
			const near = this._cameraNearFar.x, far = this._cameraNearFar.y;
			const previousDepth = this._cameraOrtho.greaterThan( 0.5 ).select( viewZToOrthographicDepth( prevViewZ, near, far ), viewZToPerspectiveDepth( prevViewZ, near, far ) );

			// history is considered valid when the UV is in range and there's no disocclusion except on edges

			const isValidUV = historyUV.greaterThanEqual( 0 ).all().and( historyUV.lessThanEqual( 1 ).all() );
			const isEdge = farthestDepth.sub( closestDepth ).greaterThan( this.edgeDepthDiff );
			const isDisocclusion = closestDepth.sub( previousDepth ).greaterThan( this.depthThreshold );
			const hasValidHistory = isValidUV.and( isEdge.or( isDisocclusion.not() ) );

			// sample the current and previous colors

			const currentColor = this.beautyNode.sample( uvNode );
			const historyColor = sampleHistory( historyUV, textureSize ).toVar();

			// increase the weight towards the current frame under motion

			const motionFactor = uvNode.sub( historyUV ).mul( textureSize ).length().div( this.maxVelocityLength ).saturate();
			const currentWeight = float( 0.05 ).toVar(); // A minimum weight

			if ( this.useSubpixelCorrection ) {

				// Increase the minimum weight towards the current frame when the velocity is more subpixel.
				currentWeight.addAssign( subpixelCorrection( offsetUV, textureSize ).mul( 0.25 ) );

			}

			currentWeight.assign( hasValidHistory.select( currentWeight.add( motionFactor ).saturate(), 1 ) );
			// a surface that moved itself: at least MOVER_WEIGHT of this frame (no trail of its older poses)
			currentWeight.assign( objectMoved.select( currentWeight.max( MOVER_WEIGHT ), currentWeight ) );

			// Perform neighborhood clipping/clamping. We use variance clipping here.

			const varianceGamma = mix( 0.5, 1, motionFactor.oneMinus().pow2() ); // Reasonable gamma range is [0.75, 2]
			// Thin geometry (Unreal's TSR "thin geometry detection": a pixel partly covered by a line thinner than a pixel
			// oscillates between the line and what is behind it as the jitter moves, the neighbourhood's box moves with it
			// and the history never converges: still buildings flickered at every window frame, 8.9 % of their pixels
			// changing between two frames of a still camera). Where nothing moved, nothing was uncovered and a high-contrast
			// line crosses the neighbourhood (luma range over 0.3, TSR's MinKeepLineContrast), the history is kept whole
			// and gathers longer (2 % of the new frame: the coverage converges); everywhere else, as before. Something that
			// moved over a still pixel (a walker crossing the pavement) leaves it uncertain for a while: the history's alpha
			// (unused past this pass: the grade writes 1) remembers motion, 1 when the pixel or its neighbourhood moved,
			// fading 15 % a frame; the history is trusted whole only once that memory is gone (else the walker left a trail).
			// (only motion: at a thin line the depth flips between the line and what is behind it with the jitter, so the
			// depth test alone, which still applies to this frame, would never let the memory clear)
			// A surface that moved itself (a walker, a vehicle) moved, however slowly: a person walking 1.4 m/s 90 m away crosses
			// under a quarter of a pixel a frame, read as still, so its few pixels (contrasted, a "thin line") kept their history
			// whole at 2 % of the new frame and the people showed as translucent smears of the pavement behind them (2026-10-31).
			// (Unreal's TAA and FSR2's reactive mask treat moving objects apart from the camera's motion for this.)
			const movedNow = motionFactor.greaterThanEqual( 0.002 ).or( hasValidHistory.not() ).or( objectMoved );
			const motionMemory = movedNow.select( float( 1 ), historyColor.a.mul( 0.85 ) );
			const thinStill = movedNow.not().and( isDisocclusion.not() ).and( historyColor.a.lessThan( 0.02 ) ).and( lumaRange( positionTexel ).greaterThan( 0.3 ) );
			currentWeight.assign( thinStill.select( currentWeight.min( 0.02 ), currentWeight ) );
			const clippedHistoryColor = thinStill.select( historyColor, varianceClipping( positionTexel, currentColor, historyColor, varianceGamma ) );

			// flicker reduction based on luminance weighing

			const output = vec4( flickerReduction( currentColor, clippedHistoryColor, currentWeight ).rgb, motionMemory );

			// debug (traaDebug = 1): red = history rejected, green = current frame weight, blue = disocclusion
			const dbgValid = vec4( hasValidHistory.select( float( 0 ), float( 1 ) ), currentWeight, isDisocclusion.select( float( 1 ), float( 0 ) ), 1 );
			return traaDebug.greaterThan( 0.5 ).select( dbgValid, output );

		} );

		// materials

		this._resolveMaterial.contextNode = context( builder.getSharedContext() );
		this._resolveMaterial.colorNode = resolve();

		return this._textureNode;

	}

	/**
	 * Frees internal resources. This method should be called
	 * when the effect is no longer required.
	 */
	dispose() {

		super.dispose();

		this._historyRenderTarget.dispose();
		this._resolveRenderTarget.dispose();

		this._resolveMaterial.dispose();

	}

}

export default TRAANode;

const _haltonOffsets = /*@__PURE__*/ computeHaltonOffsets( 32 );

/**
 * TSL function for creating a TRAA node for Temporal Reprojection Anti-Aliasing.
 *
 * @tsl
 * @function
 * @param {TextureNode} beautyNode - The texture node that represents the input of the effect.
 * @param {TextureNode} depthNode - A node that represents the scene's depth.
 * @param {TextureNode} velocityNode - A node that represents the scene's velocity.
 * @param {Camera} camera - The camera the scene is rendered with.
 * @returns {TRAANode}
 */
export const traa = ( beautyNode, depthNode, velocityNode, camera ) => new TRAANode( convertToTexture( beautyNode ), depthNode, velocityNode, camera );
