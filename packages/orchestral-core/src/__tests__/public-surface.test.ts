import { describe, expect, it } from 'vitest'

import * as api from '../index'

// Phase 4 runtime-freeze gate: pin the set of *value* exports (class /
// function / const) on the public barrel. `Object.keys` does not see pure
// `type` / `interface` exports — type-level drift is caught by Phase 5's
// api-extractor instead. The value of this snapshot is catching a value
// export being added or removed without a deliberate review.
describe('@orchestral/core public surface', () => {
  it('value exports are frozen', () => {
    expect(Object.keys(api).sort()).toMatchInlineSnapshot(`
      [
        "AGENT_BASE_INPUT_SCHEMA",
        "AGENT_FINISH_TOOL_NAME",
        "ASSET_MARKER",
        "AskUserChoiceAnswerSchema",
        "AskUserChoicePayloadSchema",
        "AskUserConfirmAnswerSchema",
        "AskUserConfirmPayloadSchema",
        "AskUserFieldValueSchema",
        "AskUserFormAnswerSchema",
        "AskUserFormFieldSchema",
        "AskUserFormPayloadSchema",
        "DEFAULT_AGENT_FINISH_SPEC",
        "DEFAULT_SUBAGENT_BLOCKLIST",
        "DispatchPatternInputSchema",
        "FindPatternInputSchema",
        "InMemoryAssetStore",
        "InMemoryJobStore",
        "InMemoryTranscriptStore",
        "LIFT_MARKER",
        "ManifestError",
        "ModelExcludedError",
        "NoModelForCapabilityError",
        "OrchestralManifestPatternSchema",
        "OrchestralManifestSchema",
        "PatternRegistry",
        "agentInputSchema",
        "assetIdField",
        "auditOutputsSchema",
        "boundedText",
        "buildAlwaysLoadDescriptors",
        "buildAskUserFacade",
        "buildAssetIndex",
        "buildCatalogDescriptors",
        "buildFinishDescriptor",
        "createDefaultCapabilityRouter",
        "createPatternFn",
        "defaultAgentFinishCompose",
        "defaultAgentFinishInputs",
        "defaultAgentFinishOutputs",
        "defineAtomicPattern",
        "deriveCapabilities",
        "deriveLlmFacingInputSchema",
        "deriveReferencesSchema",
        "dispatchEnvelopeShape",
        "extendInputsWithReferences",
        "formatRoutingExplanation",
        "fromAssetUri",
        "inferNamespace",
        "isAssetUri",
        "isDispatchError",
        "metaEnvelopeShape",
        "mintHandle",
        "opaqueToken",
        "parallel",
        "producedAssetShape",
        "projectAssetsForModel",
        "projectToolOutputForModel",
        "resolveAssetReferences",
        "resolveDispatchTarget",
        "resolveExposure",
        "resolveNamespace",
        "resolveSlashDispatch",
        "sanitizeToolOutput",
        "setAssetUriScheme",
        "toAssetUri",
        "toJsonSchema",
        "urlField",
        "whenAlways",
        "whenCapabilityUnavailable",
        "whenPreservesRequired",
      ]
    `)
  })
})
