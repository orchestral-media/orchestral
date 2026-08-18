// @orchestral/patterns — first-party Pattern catalog. Populated in Phases B–C.

// ── First-party Pattern factories ────────────────────────────────────────
export {
  TEXT_TO_IMAGE_PATTERN_ID,
  TextToImagePrimaryInputSchema,
  TextToImageOutputSchema,
  createTextToImagePattern,
  textToImage,
  type TextToImageInput,
  type TextToImageOutput,
  type ImageGenerationParams,
} from './atomic/text-to-image'

export {
  IMAGE_TO_IMAGE_PATTERN_ID,
  ImageToImagePrimaryInputSchema,
  ImageToImageOutputSchema,
  createImageToImagePattern,
  imageToImage,
  type ImageToImagePatternInit,
  type ImageToImageInput,
  type ImageToImageOutput,
} from './atomic/image-to-image'

export {
  IMAGE_TO_TEXT_PATTERN_ID,
  ImageToTextPrimaryInputSchema,
  ImageToTextOutputSchema,
  createImageToTextPattern,
  imageToText,
  type ImageToTextPatternInit,
  type ImageToTextInput,
  type ImageToTextOutput,
} from './atomic/image-to-text'

export {
  TEXT_TO_VIDEO_PATTERN_ID,
  TextToVideoPrimaryInputSchema,
  TextToVideoOutputSchema,
  createTextToVideoPattern,
  type TextToVideoPatternInit,
  type TextToVideoInput,
  type TextToVideoOutput,
} from './atomic/text-to-video'

export {
  IMAGE_TO_VIDEO_PATTERN_ID,
  ImageToVideoPrimaryInputSchema,
  ImageToVideoOutputSchema,
  createImageToVideoPattern,
  imageToVideo,
  type ImageToVideoPatternInit,
  type ImageToVideoInput,
  type ImageToVideoOutput,
} from './atomic/image-to-video'

export {
  VIDEO_TO_VIDEO_PATTERN_ID,
  VideoToVideoPrimaryInputSchema,
  VideoToVideoOutputSchema,
  createVideoToVideoPattern,
  type VideoToVideoPatternInit,
  type VideoToVideoInput,
  type VideoToVideoOutput,
} from './atomic/video-to-video'

export {
  TEXT_TO_SPEECH_PATTERN_ID,
  TextToSpeechPrimaryInputSchema,
  TextToSpeechOutputSchema,
  createTextToSpeechPattern,
  textToSpeech,
  type TextToSpeechPatternInit,
  type TextToSpeechInput,
  type TextToSpeechOutput,
} from './atomic/text-to-speech'

export {
  TEXT_TO_AUDIO_PATTERN_ID,
  TextToAudioPrimaryInputSchema,
  TextToAudioOutputSchema,
  createTextToAudioPattern,
  textToAudio,
  type TextToAudioPatternInit,
  type TextToAudioInput,
  type TextToAudioOutput,
} from './atomic/text-to-audio'

export {
  AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID,
  AutomaticSpeechRecognitionPrimaryInputSchema,
  AutomaticSpeechRecognitionOutputSchema,
  createAutomaticSpeechRecognitionPattern,
  automaticSpeechRecognition,
  type AutomaticSpeechRecognitionPatternInit,
  type AutomaticSpeechRecognitionInput,
  type AutomaticSpeechRecognitionOutput,
  type AsrTranscriptionParams,
} from './atomic/automatic-speech-recognition'

export {
  TEXT_GENERATION_PATTERN_ID,
  TextGenerationPrimaryInputSchema,
  TextGenerationOutputSchema,
  createTextGenerationPattern,
  textGeneration,
  type TextGenerationPatternInit,
  type TextGenerationInput,
  type TextGenerationOutput,
} from './atomic/text-generation'

export {
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  ImageToImageViaCaptionInputSchema,
  ImageToImageViaCaptionOutputSchema,
  createImageToImageViaCaptionPattern,
  type ImageToImageViaCaptionInput,
  type ImageToImageViaCaptionOutput,
} from './atomic/image-to-image-via-caption'

// ── First-party meta/agent pipelines ─────────────────────────────────────
export {
  SCRIPT_PLANNING_PATTERN_ID,
  ScriptPlanningInputSchema,
  ScriptPlanningOutputSchema,
  createScriptPlanningMeta,
  type ScriptPlanningInput,
  type ScriptPlanningOutput,
  type ScriptPlanningMetaInit,
  type ScriptPlanningPromptOverrides,
} from './meta/script-planning'

export {
  REFERENCE_IMAGE_CASCADE_PATTERN_ID,
  ReferenceImageCascadeInputSchema,
  ReferenceImageCascadeOutputSchema,
  createReferenceImageCascadeMeta,
  type ReferenceImageCascadeInput,
  type ReferenceImageCascadeOutput,
  type ReferenceImageCascadeMetaInit,
  type ReferenceImageCascadePromptOverrides,
} from './meta/reference-image-cascade'

export {
  SCRIPT2VIDEO_PATTERN_ID,
  ScriptToVideoInputSchema,
  ScriptToVideoOutputSchema,
  createScript2VideoMeta,
  script2videoMeta,
  CharacterInSceneSchema,
  type ScriptToVideoInput,
  type ScriptToVideoOutput,
  type ScriptToVideoMetaDeps,
  type ScriptToVideoPromptOverrides,
  type CharacterInScene,
} from './meta/script2video'

export {
  IDEA2VIDEO_PATTERN_ID,
  IdeaToVideoInputSchema,
  IdeaToVideoOutputSchema,
  createIdea2VideoMeta,
  type IdeaToVideoInput,
  type IdeaToVideoOutput,
  type IdeaToVideoMetaDeps,
  type IdeaToVideoPromptOverrides,
} from './meta/idea2video'

export {
  PROSE_CHUNKING_PATTERN_ID,
  ProseChunkingInputSchema,
  ProseChunkingOutputSchema,
  createProseChunkingMeta,
  proseChunkingMeta,
  type ProseChunkingInput,
  type ProseChunkingOutput,
  type ProseChunkingMetaInit,
  type ProseChunkingPromptOverrides,
} from './meta/prose-chunking'

export {
  NOVEL_TO_EVENTS_PATTERN_ID,
  NovelToEventsInputSchema,
  NovelToEventsOutputSchema,
  EventResponseSchema,
  createNovelToEventsMeta,
  type NovelToEventsInput,
  type NovelToEventsOutput,
  type NovelToEventsMetaInit,
  type NovelToEventsPromptOverrides,
  type Event,
} from './meta/novel-to-events'

export {
  EVENT_TO_SCRIPT_PATTERN_ID,
  EventToScriptInputSchema,
  EventToScriptOutputSchema,
  SceneSchema,
  PolishedSceneSchema,
  createEventToScriptMeta,
  CharacterInEventSchema,
  type EventToScriptInput,
  type EventToScriptOutput,
  type EventToScriptMetaInit,
  type EventToScriptPromptOverrides,
  type Scene,
  type PolishedScene,
  type CharacterInEvent,
} from './meta/event-to-script'

export {
  IMAGE_BEST_OF_N_PATTERN_ID,
  ImageBestOfNInputSchema,
  ImageBestOfNOutputSchema,
  createImageBestOfNMeta,
  imageBestOfNMeta,
  type ImageBestOfNInput,
  type ImageBestOfNOutput,
  type ImageBestOfNMetaInit,
  type ImageBestOfNPromptOverrides,
} from './meta/image-best-of-n'

export {
  STORYBOARD_PATTERN_ID,
  StoryboardInputSchema,
  StoryboardOutputSchema,
  ShotBriefSchema,
  PanelSchema,
  createStoryboardMeta,
  type StoryboardInput,
  type StoryboardOutput,
  type StoryboardMetaInit,
  type StoryboardPromptOverrides,
  type ShotBrief,
  type StoryboardPanel,
} from './meta/storyboard'

export {
  PRODUCT_AD_SHORT_PATTERN_ID,
  ProductAdShortInputSchema,
  ProductAdShortOutputSchema,
  createProductAdShortMeta,
  type ProductAdShortInput,
  type ProductAdShortOutput,
  type ProductAdShortMetaDeps,
  type ProductAdShortPromptOverrides,
} from './meta/product-ad-short'

export {
  PRODUCT_PHOTO_PACK_PATTERN_ID,
  ProductPhotoPackInputSchema,
  ProductPhotoPackOutputSchema,
  createProductPhotoPackMeta,
  type ProductPhotoPackInput,
  type ProductPhotoPackOutput,
  type ProductPhotoPackMetaInit,
  type ProductPhotoPackPromptOverrides,
} from './meta/product-photo-pack'

export {
  UGC_TESTIMONIAL_PATTERN_ID,
  UgcTestimonialInputSchema,
  UgcTestimonialOutputSchema,
  createUgcTestimonialMeta,
  type UgcTestimonialInput,
  type UgcTestimonialOutput,
  type UgcTestimonialMetaDeps,
  type UgcTestimonialPromptOverrides,
} from './meta/ugc-testimonial'

export {
  EXPLAINER_SHORT_PATTERN_ID,
  ExplainerShortInputSchema,
  ExplainerShortOutputSchema,
  createExplainerShortMeta,
  type ExplainerShortInput,
  type ExplainerShortOutput,
  type ExplainerShortMetaDeps,
  type ExplainerShortPromptOverrides,
} from './meta/explainer-short'

export {
  LYRICS_TO_MV_PATTERN_ID,
  LyricsToMvInputSchema,
  LyricsToMvOutputSchema,
  createLyricsToMvMeta,
  type LyricsToMvInput,
  type LyricsToMvOutput,
  type LyricsToMvMetaDeps,
  type LyricsToMvPromptOverrides,
} from './meta/lyrics-to-mv'

export {
  AGENT_LONG_FORM_VIDEO_PATTERN_ID,
  AgentLongFormVideoInputSchema,
  createLongFormVideoAgent,
  type AgentLongFormVideoInput,
} from './agent/long-form-video'

export {
  AGENT_ORCHESTRATOR_PATTERN_ID,
  OrchestratorInputSchema,
  createOrchestratorAgent,
  type OrchestratorInput,
} from './agent/orchestrator'

// ── Meta prompt-override defaults ─────────────────────────────────────────
// Each meta inlines its system prompts as module constants. These frozen
// `*_DEFAULT_PROMPTS` objects expose those defaults keyed by the same names a
// consumer passes to the factory's `prompts` override map — so a consumer can
// tweak tone / house style / localization for one step while spreading the
// rest of the defaults, without forking the package. The raw prompt constants
// stay internal (available to test code via the `./testing` subpath only).
export { IDEA2VIDEO_DEFAULT_PROMPTS } from './meta/idea2video'
export { SCRIPT2VIDEO_DEFAULT_PROMPTS } from './meta/script2video'
export { SCRIPT_PLANNING_DEFAULT_PROMPTS } from './meta/script-planning'
export { STORYBOARD_DEFAULT_PROMPTS } from './meta/storyboard'
export { EXPLAINER_SHORT_DEFAULT_PROMPTS } from './meta/explainer-short'
export { EVENT_TO_SCRIPT_DEFAULT_PROMPTS } from './meta/event-to-script'
export { NOVEL_TO_EVENTS_DEFAULT_PROMPTS } from './meta/novel-to-events'
export { PROSE_CHUNKING_DEFAULT_PROMPTS } from './meta/prose-chunking'
export { LYRICS_TO_MV_DEFAULT_PROMPTS } from './meta/lyrics-to-mv'
export { UGC_TESTIMONIAL_DEFAULT_PROMPTS } from './meta/ugc-testimonial'
export { PRODUCT_AD_SHORT_DEFAULT_PROMPTS } from './meta/product-ad-short'
export { PRODUCT_PHOTO_PACK_DEFAULT_PROMPTS } from './meta/product-photo-pack'
export { IMAGE_BEST_OF_N_DEFAULT_PROMPTS } from './meta/image-best-of-n'
export { REFERENCE_IMAGE_CASCADE_DEFAULT_PROMPTS } from './meta/reference-image-cascade'

// ── Shared meta authoring surface ────────────────────────────────────────
// The host-op contract every deliverable meta Picks from, plus every helper
// the shipped metas use in their compose(). This is the full set an author
// needs to copy one of the exemplar metas into their own package and have it
// compile against `@orchestral/patterns` alone — the exemplars import exactly
// these names. Exported so a consumer can also build one shared deps object
// typed against the full op set.
//
// Stability: these follow the package's 0.x policy (see CHANGELOG) — the
// signatures are settled and covered by the frozen public-surface snapshot,
// but a minor release may still break them before 1.0.
export {
  firstAssetId,
  parseJsonWithSchema,
  resolvePrompts,
  styleTag,
  sumCosts,
  toJsonSchemaCached,
  type MetaCommonDeps,
} from './meta/_shared/meta-utils'
