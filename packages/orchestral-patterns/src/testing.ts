// Test-only surface — NOT part of the public API (the `.` barrel).
//
// The first-party meta pipelines inline their system prompts as module
// constants. Cross-package tests (the runtime meta-dispatch e2e) need to assert
// on the exact prompt bytes a step received, but deep imports into package
// internals are forbidden by the `exports` map. This `./testing` subpath is the
// sanctioned seam for that: it exposes the prompt constants to test code without
// putting them on the public surface where library consumers would see them.
export {
  SCRIPT_INTENT_ROUTING_PROMPT,
  NARRATIVE_SCRIPT_PLANNING_PROMPT,
  MOTION_SCRIPT_PLANNING_PROMPT,
  MONTAGE_SCRIPT_PLANNING_PROMPT,
} from './meta/script-planning/prompts'
