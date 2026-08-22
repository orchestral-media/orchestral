// Inlined prompt constants for this pattern. Compile-time constants, not
// loaded at dispatch — this file is the authoritative copy. Upstream
// provenance for the ViMax-derived constants is recorded in CREDITS.md.
//
// Two kinds of constant live here, shaped differently because different
// models read them:
//
// - Planning prompts (CHARACTER_EXTRACTION, STORYBOARD_DESIGN,
//   SHOT_VISUAL_DECOMPOSITION, CAMERA_TREE_CONSTRUCTION) go to
//   text-generation as the `system` field. They address an LLM, declare the
//   `<TAG>` input blocks the meta emits, and fix a JSON output shape the meta
//   parses with a matching zod schema.
// - Render prompts (PORTRAIT_FRONT / SIDE / BACK, CINEMATIC_SHOT_FRAMING,
//   I2V_SHOT_SINGLE / TRANSITION) go to text-to-image, image-to-image, and
//   image-to-video as the leading part of the `prompt` field — those atomics
//   have no system slot. They address the diffusion or video model directly,
//   in concrete visual language, and the meta appends the per-call specifics
//   (character features, frame description, motion and audio lines) after
//   them. An earlier revision wrote these as briefs to an LLM that would
//   write the prompt ("[Output] A single text-to-image prompt … Concrete
//   template:") and then handed that brief to the image model verbatim; no
//   stage in the DAG ever ran such an LLM step. Where a render prompt still
//   carries the ViMax template sentence it was derived from, it is the
//   sentence the image model was always meant to see.
//
// STORYBOARD_DESIGN_PROMPT is shared with meta_storyboard, so it lives in
// ../_shared/storyboard-design-prompt and is re-exported here for the callers
// that import it off this module.

export { STORYBOARD_DESIGN_PROMPT } from '../_shared/storyboard-design-prompt'

export const CHARACTER_EXTRACTION_PROMPT = `# Character Extraction

[Role]
You are a top-tier movie script analysis expert.

[Task]
Your task is to analyze the provided script and extract all relevant character information.

[Input]
You will receive a script enclosed within \`<SCRIPT>\` and \`</SCRIPT>\`.

Below is a simple example of the input:

\`\`\`
<SCRIPT>
A young woman sits alone at a table, staring out the window. She takes a sip of her coffee and sighs. The liquid is no longer warm, just a bitter reminder of the time that has passed. Outside, the world moves in a blur of hurried footsteps and distant car horns, but inside the quiet café, time feels thick and heavy.
Her finger traces the rim of the ceramic mug, following the imperfect circle over and over. The decision she had to make was supposed to be simple—a mere checkbox on the form of her life. Yes or No. Stay or Go. Yet, it had rooted itself in her chest, a tangled knot of fear and longing.
</SCRIPT>
\`\`\`

[Output]
Return a JSON object with this shape:

\`\`\`jsonc
{
  "characters": [
    {
      "idx": 0,                            // int, 0-based, stable within the scene
      "identifierInScene": "the barista",  // canonical name; pronoun/role/trait if unnamed
      "staticFeatures": "...",             // physical appearance, physique
      "dynamicFeatures": "...",            // attire, accessories, key items
      "isVisible": true                    // false for off-screen voices etc.
    }
  ]
}
\`\`\`

[Guidelines]
- Ensure that the language of all output values (not include keys) matches that used in the script.
- Group all names referring to the same entity under one character. Select the most appropriate name as the character's identifier. If the script names a real public figure, keep that name rather than replacing it with a generic label.
- If the character's name is not mentioned, you can use reasonable pronouns to refer to them, including using their occupation or notable physical traits. For example, "the young woman" or "the barista".
- For background characters in the script, you do not need to consider them as individual characters.
- If a character's traits are not described or only partially outlined in the script, you need to design plausible features based on the context to make their characteristics more complete and detailed, ensuring they are vivid and evocative.
- In static features, you need to describe the character's physical appearance, physique, and other relatively unchanging features. In dynamic features, you need to describe the character's attire, accessories, key items they carry, and other easily changeable features.
- Don't include any information about the character's personality, role, or relationships with others in either static or dynamic features.
- When designing character features, within reasonable limits, different character appearances should be made more distinct from each other.
- The description of characters should be detailed, avoiding the use of abstract terms. Instead, employ descriptions that can be visualized—such as specific clothing colors and concrete physical traits (e.g., large eyes, a high nose bridge).`

// ── Render prompts ─────────────────────────────────────────────────────────
// Each of these is the opening of a `prompt` sent to an image or video
// model. The meta appends the per-call specifics after a blank line:
//   PORTRAIT_FRONT          + `Character: <identifier>` / `Features: <…>` / style
//   PORTRAIT_SIDE / BACK    + `Character: <identifier>`   (source = front portrait)
//   CINEMATIC_SHOT_FRAMING  + reference legend (root shots) / frame description
//                             / style / camera-tree hint (child shots)
//   I2V_SHOT_SINGLE         + motion line / audio line
//   I2V_SHOT_TRANSITION     + `First shot: <…>` / `Second shot: <…>` / style

/**
 * Front view of the 3-view portrait set — text-to-image, no reference. The
 * only portrait that sees the character's features: side and back inherit
 * identity from this image through image-to-image.
 */
export const PORTRAIT_FRONT_PROMPT = `Generate a full-body, front-view portrait of the character described below, with a pure white background. The character should be centered in the image, occupying most of the frame. Gazing straight ahead. Standing with arms relaxed at sides. Natural expression. This is the front sheet of a character reference set: render every listed feature exactly, and keep the background empty — no props, no scenery, no text.`

/**
 * Side view — image-to-image with the front portrait as `source`. Features
 * are deliberately not restated: the source image carries identity, and
 * restating it in words double-anchors the character and drifts.
 */
export const PORTRAIT_SIDE_PROMPT = `Generate a full-body, side-view portrait of the character in the source image, with a pure white background. The character should be centered in the image, occupying most of the frame. Facing left, in full profile. Standing with arms relaxed at sides. Same face, hair, build, and outfit as the source image — change only the viewing angle. No props, no scenery, no text.`

/** Back view — image-to-image with the front portrait as `source`. */
export const PORTRAIT_BACK_PROMPT = `Generate a full-body, back-view portrait of the character in the source image, with a pure white background. The character should be centered in the image, occupying most of the frame. Seen from directly behind, so that no facial features are visible. Standing with arms relaxed at sides. Same hair, build, and outfit as the source image — change only the viewing angle. No props, no scenery, no text.`

export const SHOT_VISUAL_DECOMPOSITION_PROMPT = `# Shot Visual Decomposition

[Role]
You are a professional visual text analyst, proficient in cinematic language and shot narration. Your expertise lies in deconstructing a comprehensive shot description accurately into three core components: the static first frame, the static last frame, and the dynamic motion that connects them.

[Task]
Your task is to dissect and rewrite a user-provided visual text description of a shot strictly and insightfully into three distinct parts:
- First Frame Description: Describe the static image at the very beginning of the shot. Focus on compositional elements, initial character postures, environmental layout, lighting, color, and other static visual aspects.
- Last Frame Description: Describe the static image at the very end of the shot. Similarly, focus on the static composition, but it must reflect the final state after changes caused by camera movement or internal element motion.
- Motion Description: Describe all movements that occur between the first frame and the last frame. This includes camera movement (e.g., static, push-in, pull-out, pan, track, follow, tilt, etc.) and movement of elements within the shot (e.g., character movement, object displacement, changes in lighting, etc.). This is the most dynamic part of the entire description. For the movement and changes of a character, you cannot directly use the character's name to refer to them. Instead, you need to refer to the character by their external features, especially noticeable ones like clothing characteristics.

[Input]
You will receive a single visual text description of a shot that typically implicitly or explicitly contains information about the starting state, the motion process, and the ending state.
Additionally, you will receive a sequence of potential characters, each containing an identifier and a feature.
- The description is enclosed within \`<VISUAL_DESC>\` and \`</VISUAL_DESC>\`.
- The character list is enclosed within \`<CHARACTERS>\` and \`</CHARACTERS>\`. Each line is \`#<idx> <identifier>: <features>\`; report those \`idx\` values in \`ff_vis_char_idxs\` / \`lf_vis_char_idxs\`.

[Output]
Return a JSON object with this shape:

\`\`\`jsonc
{
  "ff_desc": "Medium shot of a supermarket aisle at eye level. Bob(a tall man wearing a blue shirt and jeans) is positioned on the right side of the frame, captured in profile and facing right, while Alice(a young woman with short hair, wearing a green dress) is on the left, shown pushing a shopping cart with her gaze lowered toward the ground. ...",
  "ff_vis_char_idxs": [0, 1],
  "lf_desc": "...",
  "lf_vis_char_idxs": [0, 1],
  "motion_desc": "Static camera. Alice (short hair, wearing a green dress) is walking towards the camera.",
  "variation_type": "small"        // "large" | "medium" | "small"
}
\`\`\`

[Guidelines]
- Ensure all output values (except keys) match the language used in the script.
- Ensure the first and last frame descriptions are pure "snapshots," containing no ongoing actions (e.g., "He is about to stand up" is unacceptable; it should be "He is sitting on the chair, leaning slightly forward").
- In the motion description, you must clearly distinguish between camera movement and on-screen movement. Use professional cinematic terminology (e.g., dolly shot, pan, zoom, etc.) as precisely as possible to describe camera movement.
- In the motion description, you cannot directly use character names to refer to characters; instead, you should use the characters' visible characteristics to refer to them. For example, "Alice is walking" is unacceptable; it should be "Alice (short hair, wearing a green dress) is walking".
- The last frame description must be logically consistent with the first frame description and the motion description. All actions described in the motion section should be reflected in the static image of the last frame.
- If the input description is ambiguous about certain details, you may make reasonable inferences and additions based on the context to make all three sections complete and fluent. However, core elements must strictly adhere to the input text.
- Use accurate, concise, and professional descriptive language. Avoid overly literary rhetoric such as metaphors or emotional flourishes; focus on providing information that can be visualized.
- Similar to the input visual description, the first and last frame descriptions should include details such as shot type, angle, composition, etc.
- Below are the three types of variation within a shot (not between two shots):
  - 'large' cases typically involve the exaggerated transition shots which means a significant change in the composition and focus, such as smoothly changing from a wide shot to a close-up. It is usually accompanied by significant camera movement (e.g., drone perspective shots across the city).
  - 'medium' cases often involve the introduction of new characters and a character turns from the back to face the front (facing the camera).
  - 'small' cases usually involve minor changes, such as expression changes, movement and pose changes of existing characters (e.g., walking, sitting down, standing up), moderate camera movements (e.g., pan, tilt, track).
- The variation type is consumed: for a 'medium' or 'large' shot the last frame is rendered as its own image and handed to the video model as the end frame; a 'small' shot animates from the first frame and the motion description alone. Choose 'medium' or 'large' only when the closing composition genuinely differs from the opening one.
- When describing a character, it is necessary to indicate the direction they are facing.
- The first shot must establish the overall scene environment, using the widest possible shot.
- Use as few camera positions as possible.`

export const CAMERA_TREE_CONSTRUCTION_PROMPT = `# Camera Tree Construction

[Role]
You are a professional video editing expert specializing in multi-camera shot analysis and scene structure modeling. You have deep knowledge of cinematic language, enabling you to understand shot sizes (e.g., wide shot, medium shot, close-up) and content inclusion relationships. You can infer hierarchical structures between camera positions based on corresponding shot descriptions.

[Task]
Your task is to analyze the input camera position data to construct a "camera position tree". This tree structure represents a relationship where a parent camera's content encompasses that of a child camera. Specifically, you need to identify the parent camera for each camera position (if one exists) and determine the dependent shot indices (i.e., the specific shots within the parent camera's footage that contain the child camera's content). If a camera position has no parent, output null for the parent fields.

[Input]
The input is a sequence of cameras. The sequence will be enclosed within \`<CAMERA_SEQ>\` and \`</CAMERA_SEQ>\`.
Each camera contains a sequence of shots filmed by the camera, which will be enclosed within \`<CAMERA_N>\` and \`</CAMERA_N>\`, where N is the index of the camera. The indices are whatever the storyboard assigned — they are not guaranteed to be contiguous, so the input may contain \`<CAMERA_0>\` and \`<CAMERA_2>\` with no \`<CAMERA_1>\`.

Below is an example of the input format:

\`\`\`
<CAMERA_SEQ>
<CAMERA_0>
Shot 0: Medium shot of the street. Alice and Bob are walking towards each other.
Shot 2: Medium shot of the street. Alice and Bob hug each other.
</CAMERA_0>
<CAMERA_1>
Shot 1: Close-up of the Alice's face. Her expression shifts from surprise to delight as she recognizes Bob.
</CAMERA_1>
</CAMERA_SEQ>
\`\`\`

[Output]
Return a JSON object with this shape:

\`\`\`jsonc
{
  "camera_parent_items": [
    {
      "cam_idx": 0,                              // the N of the <CAMERA_N> this entry answers for
      "parent_cam_idx": null,                    // null: this camera is the root
      "parent_shot_idx": null,
      "reason": "The first camera is the root of the tree.",
      "is_parent_fully_covers_child": null,
      "missing_info": null
    },
    {
      "cam_idx": 1,
      "parent_cam_idx": 0,                       // index of the parent camera
      "parent_shot_idx": 0,                      // shot in the parent that covers this child
      "reason": "The parent shot's field of view covers the child shot's field of view (from medium shot to close-up)",
      "is_parent_fully_covers_child": false,
      "missing_info": "The frontal view of Alice."  // null when the parent fully covers
    }
    // ... exactly one entry per camera in the input
  ]
}
\`\`\`

[Guidelines]
- The language of all output values (not include keys) should be consistent with the language of the input.
- Answer for every camera in the input exactly once, and echo that camera's index as \`cam_idx\`. Entries are matched to cameras by \`cam_idx\`, never by their position in the array, so a camera you leave out is an error downstream rather than a default.
- Content Inclusion Check: The parent camera should as fully as possible contain the child camera's content in certain shots (e.g., a parent medium two-shot encompasses a child over-the-shoulder reverse shot). Analyze shot descriptions by comparing keywords (e.g., characters, actions, setting) to ensure the parent shot's field of view covers the child shot's.
- Transition Smoothness Priority: Larger shot size as parent camera is preferred, such as Wide Shot → Medium Shot or Medium Shot → Close-up. The shot sizes of adjacent parent and child nodes should be as similar as possible. A direct transition from a long shot to a close-up is not allowed unless absolutely necessary.
- Temporal Proximity: Each camera is described by its corresponding first shot, and the parent camera is located based on the description of the first shot. The shot index of the parent camera should be as close as possible to the first shot index of the child camera.
- Logical Consistency: The camera tree should be acyclic, avoid circular dependencies. If a camera is contained by multiple potential parents, select the best match (based on shot size and content). If there is no suitable parent camera, output null for the parent fields.
- When a broader perspective is not available, choose the shot with the largest overlapping field of view as the parent (the one with the most information overlap), or a shot can also serve as the parent of a reverse shot. When two cameras can be the parent of each other, choose the one with the smaller index as the parent of the camera with the larger index.
- Only one camera can exist without a parent.
- When describing the elements lost in a shot, carefully compare the details between the parent shot and the child shot. For example, the parent shot is a medium shot of Character A and Character B facing each other (both in profile to the camera), while the child shot is a close-up of Character A (with Character A facing the camera directly). In this case, the child shot lacks the frontal view information of Character A.
- The first camera must be the root of the camera tree.`

/**
 * One static frame of a shot (first or last) — text-to-image with the 3-view
 * portraits of the characters in frame as `reference` images for a root
 * camera, image-to-image off the parent shot's first frame for a child camera.
 * The meta follows this with a legend naming which attached images are whose
 * (root shots), the frame description, the style, and the camera-tree hint
 * (child shots).
 */
export const CINEMATIC_SHOT_FRAMING_PROMPT = `A cinematic film still, 16:9 — one static frame of a shot. Compose the image exactly as the description below states: shot size, camera angle, where each character stands and which way they face, what sits in the foreground and background, lighting, and colour. Any attached images are identity anchors, not compositions to copy: keep each character's face, hair, build, and wardrobe exactly as shown in them. A single frozen moment — no motion blur, no split frames, no text or captions.`

/**
 * One shot's clip — image-to-video with the first frame as `startFrame` and,
 * for a medium/large-variation shot, the rendered last frame as `endFrame`.
 * The meta appends the motion line and, when the storyboard scripted one, the
 * audio line; the `[Speaker]` / `[Sound Effect]` tags on that line are the
 * storyboard's own vocabulary, passed through for the video model's audio
 * head.
 */
export const I2V_SHOT_SINGLE_PROMPT = `Animate the start frame into one continuous cinematic shot. Camera movement and on-screen action follow the motion description below exactly; every subject keeps the appearance it has in the frame. When an end frame is attached, the shot must arrive at it. A line tagged [Speaker] is dialogue: the named character speaks it with the stated emotion, lips in sync. A line tagged [Sound Effect] is the ambient sound. No on-screen text or captions.`

/**
 * The cut between two adjacent shots — image-to-video with the earlier
 * shot's first frame as `startFrame`. The meta appends both shots' visual
 * descriptions. Derived from the ViMax transition template ("Two shots. The
 * transition between the shots is a cut to. The style of the two shots
 * should be consistent.").
 */
export const I2V_SHOT_TRANSITION_PROMPT = `Two consecutive shots of the same scene, joined by a hard cut — no fade, dissolve, or wipe. The first shot begins on the attached frame. The second shot keeps the same visual style, lighting, colour grade, and character appearance, so the cut reads as continuous.`
