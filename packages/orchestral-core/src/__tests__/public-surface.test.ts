import { describe, expect, it } from 'vitest'

import * as api from '../index'
import * as memory from '../memory'
import * as routing from '../routing'

// Runtime-freeze gate: pin the set of *value* exports (class / function /
// const) on the public barrel. `Object.keys` does not see pure `type` /
// `interface` exports — type-level drift is caught by api-extractor instead
// (`pnpm api:check`). The value of this snapshot is catching a value export
// being added or removed without a deliberate review.
//
// The package publishes three entries, so all three are frozen the same way.
// The two subpaths are short by design: each is a claim about what a host has
// to name, and a symbol drifting in from the barrel would make the split
// cosmetic without any other test noticing.
describe('@orchestral/core public surface', () => {
  it('value exports are frozen', () => {
    expect(Object.keys(api).sort()).toMatchInlineSnapshot(`
      [
        "AGENT_BASE_INPUT_SCHEMA",
        "AGENT_FINISH_TOOL_NAME",
        "ASSET_KINDS",
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
        "JOB_TERMINAL_STATUSES",
        "LIFT_MARKER",
        "MODEL_SPEC_VERSION",
        "ManifestError",
        "ModelSpecVersionUnsupportedError",
        "OrchestralManifestPatternSchema",
        "OrchestralManifestSchema",
        "PatternRegistry",
        "SUPPORTED_MODEL_SPEC_VERSIONS",
        "agentInputSchema",
        "applicableAlternatives",
        "assertSupportedModelSpecVersion",
        "assetIdField",
        "assetKindField",
        "auditOutputsSchema",
        "boundedText",
        "buildAlwaysLoadDescriptors",
        "buildAskUserFacade",
        "buildAssetIndex",
        "buildCatalogDescriptors",
        "buildFinishDescriptor",
        "consoleDiagnosticsLogger",
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
        "matchSubagentBlocklist",
        "metaEnvelopeShape",
        "mintHandle",
        "nextJobState",
        "opaqueToken",
        "parallel",
        "pickAlternative",
        "producedAssetShape",
        "projectAssetsForModel",
        "projectToolOutputForModel",
        "readRequiresSemantics",
        "resolveAssetReferences",
        "resolveDispatchTarget",
        "resolveExposure",
        "resolveNamespace",
        "sanitizeToolOutput",
        "setAssetUriScheme",
        "silentDiagnosticsLogger",
        "sumCosts",
        "toAssetUri",
        "toAvailableAlternative",
        "toJsonSchema",
        "urlField",
        "whenAlways",
        "whenCapabilityUnavailable",
        "whenPreservesRequired",
      ]
    `)
  })

  it('./memory value exports are frozen', () => {
    expect(Object.keys(memory).sort()).toMatchInlineSnapshot(`
      [
        "InMemoryAssetStore",
        "InMemoryJobStore",
        "InMemoryTranscriptStore",
      ]
    `)
  })

  it('./routing value exports are frozen', () => {
    expect(Object.keys(routing).sort()).toMatchInlineSnapshot(`
      [
        "ModelExcludedError",
        "NoModelForCapabilityError",
        "createDefaultCapabilityRouter",
      ]
    `)
  })
})
