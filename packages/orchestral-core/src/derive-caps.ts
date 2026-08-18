import type { Capability } from './capability'
import type { Modality } from './capability-model'

/**
 * Derive the primary {@link Capability} list for a model from its input /
 * output modality channels. Pure function — same inputs always produce the
 * same outputs, order-stable, no side effects.
 *
 * Rules (in declared order):
 *   text-in,  text-out   → 'text-generation'
 *   audio-in, audio-out  → 'audio-to-audio' (voice clone / enhancement)
 *   audio-in, text-out   → 'automatic-speech-recognition'
 *   image-in, text-out   → 'image-to-text'  (vision-LLM caption / describe)
 *   text-in,  image-out  → 'text-to-image'
 *   image-in, image-out  → 'image-to-image'
 *   text-in,  audio-out  → 'text-to-speech'
 *   text-in,  video-out  → 'text-to-video'
 *   image-in, video-out  → 'image-to-video'
 *   video-in, video-out  → 'video-to-video'
 *   embedding-out        → 'embedding'
 *
 * Multi-mode models can satisfy multiple capabilities — gpt-image-2 with
 * `inputs=['text','image'], outputs=['image']` declares BOTH 'text-to-image'
 * AND 'image-to-image'. The dispatcher matches whichever capability the
 * Pattern requested.
 *
 * `text-to-audio` (music/SFX) shares I/O with `text-to-speech`; this function
 * returns 'text-to-speech' as the more common default. Derivation is a
 * convenience, not the source of truth: a host that knows better writes the
 * capability list it wants into `ModelCapabilityBlob.capabilities` instead of
 * calling this.
 */
export function deriveCapabilities(
  inputs: readonly Modality[],
  outputs: readonly Modality[],
): Capability[] {
  const caps: Capability[] = []
  const hasInput = (m: Modality): boolean => inputs.includes(m)
  const hasOutput = (m: Modality): boolean => outputs.includes(m)

  if (hasOutput('text') && hasInput('text')) caps.push('text-generation')
  if (hasInput('audio') && hasOutput('audio')) caps.push('audio-to-audio')
  if (hasOutput('text') && hasInput('audio')) caps.push('automatic-speech-recognition')
  if (hasOutput('text') && hasInput('image')) caps.push('image-to-text')
  if (hasOutput('image') && hasInput('text')) caps.push('text-to-image')
  if (hasOutput('image') && hasInput('image')) caps.push('image-to-image')
  if (hasOutput('audio') && hasInput('text')) caps.push('text-to-speech')
  if (hasOutput('video') && hasInput('text')) caps.push('text-to-video')
  if (hasOutput('video') && hasInput('image')) caps.push('image-to-video')
  if (hasInput('video') && hasOutput('video')) caps.push('video-to-video')
  if (hasOutput('embedding')) caps.push('embedding')

  return caps
}
