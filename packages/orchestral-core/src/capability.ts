// Naming follows HuggingFace task taxonomy for ecosystem familiarity.
// Zero runtime dependency on HuggingFace — no @huggingface/tasks, no HF token needed.
//
// An atomic Pattern's id IS its capability (`Pattern.id ≡ Capability` is the
// equation the runtime dispatches on — see foundational.ts), and the union is
// open so a host can route capabilities core does not name. The open tail is
// also why two packages can ship the same third-party name: a capability
// core does not define is namespaced by its vendor, `<vendor>__<capability>`
// (`acme__video-concat`), and the registry warns CAPABILITY_NOT_NAMESPACED
// for an atomic that is neither first-party nor prefixed that way.

export type Capability =
  // text
  | 'text-generation'
  | 'summarization'
  | 'translation'
  // image
  | 'text-to-image'
  | 'image-to-image'
  | 'image-to-text'
  | 'image-segmentation'
  // video
  | 'text-to-video'
  | 'image-to-video'
  | 'video-to-video'
  // audio
  | 'text-to-speech'
  | 'automatic-speech-recognition'
  | 'text-to-audio'
  | 'audio-to-audio'
  // embedding
  | 'embedding'
  // NOTE: the HF taxonomy splits `image-to-text` (caption / OCR) from
  // `image-text-to-text` (modern VLM image+text → text). This union folds both
  // onto `image-to-text` because provider APIs expose one shape for them
  // (image[] + text → text). Routing between caption-only and multimodal
  // models is a ModelTag / providerOptions concern, not a new capability.
  // host extension — literal members still autocomplete
  | (string & {})

// The literal members of `Capability`, without the open tail. `string extends
// T` is what tells `(string & {})` apart from a literal — every literal is
// assignable to `string & {}`, so `Exclude` cannot.
type LiteralsOf<T> = T extends string ? (string extends T ? never : T) : never
type FirstPartyCapability = LiteralsOf<Capability>

// The same literals as a value, for the one place that needs to ask "is this
// id a capability core names?" at run time — the registry's
// CAPABILITY_NOT_NAMESPACED lint. Not on the package barrel: the union above
// is the declaration, and the list is an implementation detail of the lint.
// `satisfies` rejects an entry that is not a union literal; the annotation on
// the export rejects a union literal that is not an entry (the type collapses
// to `never`, which the list cannot be assigned to). A literal added to one
// and not the other therefore fails to compile on these lines.
// DESIGN: capability-union-list-lock
const FIRST_PARTY_CAPABILITY_LIST = [
  'text-generation',
  'summarization',
  'translation',
  'text-to-image',
  'image-to-image',
  'image-to-text',
  'image-segmentation',
  'text-to-video',
  'image-to-video',
  'video-to-video',
  'text-to-speech',
  'automatic-speech-recognition',
  'text-to-audio',
  'audio-to-audio',
  'embedding',
] as const satisfies readonly FirstPartyCapability[]

type MissingFromList = Exclude<
  FirstPartyCapability,
  (typeof FIRST_PARTY_CAPABILITY_LIST)[number]
>

/** Every capability the `Capability` union names — first-party, in union order. */
export const FIRST_PARTY_CAPABILITIES: [MissingFromList] extends [never]
  ? typeof FIRST_PARTY_CAPABILITY_LIST
  : never = FIRST_PARTY_CAPABILITY_LIST
