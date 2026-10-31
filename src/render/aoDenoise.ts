// @ts-nocheck
// The ambient occlusion's denoise as Roadcraft 4.0 draws it (postprocess.ts:203-212, three's GTAOPass + PoissonDenoiseShader):
// at the occlusion's own resolution, into its own 8-bit target, 8 Poisson taps (rings 2, radius exponent 2), luma φ 10,
// depth φ 2, normal φ 3, radius 8; the final image reads the denoised target once a pixel.
//
// three r186's DenoiseNode (examples/jsm/tsl/display, its shader followed here) has 16 taps fixed in its loop and is
// computed where it is read: read by the final image's composite, it ran at the frame's full size, every pixel 17 taps,
// each rebuilding a normal from 9 depth reads (≈190 reads a pixel). That composite took 2.83 ms of the 11.9 ms frame
// close to the buildings (2544x993, RTX 3060, 2026-10-31); three's own note says the node adds "quite some overhead".
import { RTTNode, UnsignedByteType, Vector3 } from 'three/webgpu';
import { Fn, Loop, If, int, float, vec2, vec3, vec4, uv, dot, max, pow, abs, sin, cos, mat2, property, luminance, textureSize, uniformArray, getNormalFromDepth, getViewPosition, convertToTexture, nodeObject } from 'three/tsl';
import DenoiseNode from 'three/addons/tsl/display/DenoiseNode.js';

/** 4.0's denoise (GTAOPass defaults it kept, `updatePdMaterial({ samples: 8 })`). */
export const AO_DENOISE = { samples: 8, rings: 2, radiusExponent: 2, lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 8 } as const;

/** The Poisson disk's taps: `rings` turns, the radius growing to 1 by `radiusExponent` (three's GTAOPass layout). */
export function denoiseTaps(samples: number, rings: number, radiusExponent: number): Vector3[] {
	const taps = [];
	for ( let i = 0; i < samples; i ++ ) {
		const angle = 2 * Math.PI * rings * i / samples;
		taps.push( new Vector3( Math.cos( angle ), Math.sin( angle ), Math.pow( i / ( samples - 1 ), radiusExponent ) ) );
	}
	return taps;
}

class AoDenoiseNode extends DenoiseNode {

	static get type() {

		return 'AoDenoiseNode';

	}

	constructor( textureNode, depthNode, camera ) {

		super( textureNode, depthNode, null, camera );
		this.lumaPhi.value = AO_DENOISE.lumaPhi;
		this.depthPhi.value = AO_DENOISE.depthPhi;
		this.normalPhi.value = AO_DENOISE.normalPhi;
		this.radius.value = AO_DENOISE.radius;
		this._sampleVectors = uniformArray( denoiseTaps( AO_DENOISE.samples, AO_DENOISE.rings, AO_DENOISE.radiusExponent ) );

	}

	setup() {

		const uvNode = uv();
		const toViewInv = this._cameraProjectionMatrixInverse;
		const sampleTexture = ( p ) => this.textureNode.sample( p );
		const sampleDepth = ( p ) => this.depthNode.sample( p ).x;
		const sampleNormal = ( p ) => getNormalFromDepth( p, this.depthNode.value, toViewInv );

		const tap = Fn( ( [ center, viewNormal, viewPosition, sampleUv ] ) => {

			const texel = sampleTexture( sampleUv ).toVar();
			const viewPos = getViewPosition( sampleUv, sampleDepth( sampleUv ), toViewInv ).toVar();
			const normalSimilarity = pow( max( dot( viewNormal, sampleNormal( sampleUv ) ), 0 ), this.normalPhi );
			const lumaSimilarity = max( float( 1 ).sub( abs( luminance( texel.rgb ).sub( luminance( center ) ) ).div( this.lumaPhi ) ), 0 );
			const depthSimilarity = max( float( 1 ).sub( abs( dot( viewPosition.sub( viewPos ), viewNormal ) ).div( this.depthPhi ) ), 0 );
			const w = lumaSimilarity.mul( depthSimilarity ).mul( normalSimilarity );
			return vec4( texel.rgb.mul( w ), w );

		} );

		return Fn( () => {

			const depth = sampleDepth( uvNode ).toVar();
			const viewNormal = sampleNormal( uvNode ).toVar();
			const texel = sampleTexture( uvNode ).toVar();
			const result = property( 'vec4' );

			If( depth.greaterThanEqual( 1.0 ).or( dot( viewNormal, viewNormal ).equal( 0.0 ) ), () => {

				result.assign( texel );

			} ).Else( () => {

				const center = vec3( texel.rgb );
				const viewPosition = getViewPosition( uvNode, depth, toViewInv ).toConst();
				const noiseUv = vec2( uvNode.x, uvNode.y.oneMinus() ).mul( this._resolution.div( textureSize( this.noiseNode, 0 ) ) );
				const noiseTexel = this.noiseNode.sample( noiseUv ).toVar();
				// the disk turned per pixel by the noise (4.0's shader: noiseTexel[index % 4] · 2π, index 0)
				const a = noiseTexel.x.mul( 2 * Math.PI );
				const rotation = mat2( sin( a ), cos( a ).negate(), sin( a ), cos( a ) );
				const totalWeight = float( 1 ).toVar();
				const denoised = vec3( texel.rgb ).toVar();

				Loop( { start: int( 0 ), end: int( AO_DENOISE.samples ), type: 'int', condition: '<' }, ( { i } ) => {

					const dir = this._sampleVectors.element( i );
					const offset = rotation.mul( dir.xy.mul( float( 1 ).add( dir.z.mul( this.radius.sub( 1 ) ) ) ) ).div( this._resolution );
					const r = tap( center, viewNormal, viewPosition, uvNode.add( offset ) );
					denoised.addAssign( r.xyz );
					totalWeight.addAssign( r.w );

				} );

				If( totalWeight.greaterThan( 0 ), () => denoised.divAssign( totalWeight ) );
				result.assign( vec4( denoised, texel.a ) );

			} );

			return result;

		} )();

	}

}

/** A target that takes the size of the occlusion's texture before each draw (its own pass at the AO's resolution). */
class AoSizedTarget extends RTTNode {

	constructor( node, aoTexture ) {

		super( node, 1, 1, { type: UnsignedByteType, depthBuffer: false } );
		this.aoTexture = aoTexture;

	}

	updateBefore( frame ) {

		const { width, height } = this.aoTexture.image;
		if ( width !== this.renderTarget.width || height !== this.renderTarget.height ) this.setSize( width, height );
		return super.updateBefore( frame );

	}

}

/**
 * The occlusion `ao` (a texture node at its own resolution, e.g. the half-size GTAO's) denoised as 4.0 does, in its own
 * pass at that resolution: a texture node the final image samples (bilinear up to the frame's size, as 4.0's composite).
 */
export function aoDenoise( ao, depth, camera ) {

	const aoTex = convertToTexture( ao );
	const node = new AoDenoiseNode( aoTex, nodeObject( depth ), camera );
	const target = new AoSizedTarget( node, aoTex.value );
	return { texture: target, node };

}

