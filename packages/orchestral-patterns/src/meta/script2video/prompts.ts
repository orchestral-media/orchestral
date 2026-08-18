// Inlined prompt constants for this pattern (frontmatter-stripped SKILL.md
// bodies). Authoritative source; no SkillLoader at dispatch.
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

export const PORTRAIT_FRONT_PROMPT = `# Portrait — Front View

[Role]
You generate a clean front-view character portrait that serves as the identity anchor for a 3-view portrait registry (front + side + back). The front view is the only step that consumes character features; side and back views inherit identity from this image via image-to-image and must not re-state features.

[Task]
Render a full-body, front-view portrait on a pure white background, centered, occupying most of the frame, with the character gazing straight ahead, standing with arms relaxed at sides, in a natural expression.

[Input]
- \`identifier\`: The character's \`identifier_in_scene\` string (e.g. "Alice", "the barista").
- \`features\`: Concatenated \`static_features\` + \`dynamic_features\` (from upstream \`character-extraction\`).
- \`style\`: Optional global style descriptor (e.g. "Studio Ghibli", "photoreal cinematic").

[Output]
A single text-to-image prompt that yields a clean front portrait. Concrete template:

\`\`\`
Generate a full-body, front-view portrait of character {identifier} based on the following description, with a pure white background. The character should be centered in the image, occupying most of the frame. Gazing straight ahead. Standing with arms relaxed at sides. Natural expression.
Features: {features}
Style: {style}
\`\`\`

[Guidelines]
- Pure white background and "centered, occupying most of the frame" constraints are non-negotiable; downstream shot framing depends on them.
- Pass \`features\` only here — the \`portrait-side\` and \`portrait-back\` skills use the front portrait as image-to-image reference and must not double-anchor identity by re-stating features.
- \`features\` should already be split into static + dynamic per \`character-extraction\`; do not collapse them.`

export const PORTRAIT_SIDE_PROMPT = `# Portrait — Side View

[Role]
You generate the left-profile side view of a character on a pure white background, inheriting identity from the provided front-view portrait. Do not re-state character features in the prompt; the image-to-image reference carries identity.

[Task]
Render a full-body, side-view portrait on a pure white background, centered, occupying most of the frame, facing left (cinematic convention for left-profile sheets), standing with arms relaxed at sides.

[Input]
- \`identifier\`: The character's \`identifier_in_scene\` string.
- Reference image: the front portrait (image-to-image \`source\`).

[Output]
A single image-to-image prompt. Concrete template:

\`\`\`
Generate a full-body, side-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. The character should be centered in the image, occupying most of the frame. Facing left. Standing with arms relaxed at sides.
\`\`\`

[Guidelines]
- Identity is anchored by the front-view reference image; do not re-inject \`features\` into the prompt — that double-anchors identity and tends to drift.
- Side faces left by cinematic convention; right-profile is not the default.
- Side and back views are independent of each other; both only depend on front and can run in parallel.`

export const PORTRAIT_BACK_PROMPT = `# Portrait — Back View

[Role]
You generate the back view of a character on a pure white background, inheriting identity from the provided front-view portrait. No facial features should be visible (camera is fully behind the character). Do not re-state features in the prompt; the image-to-image reference carries identity.

[Task]
Render a full-body, back-view portrait on a pure white background, centered, occupying most of the frame, showing the character from behind. No facial features should be visible.

[Input]
- \`identifier\`: The character's \`identifier_in_scene\` string.
- Reference image: the front portrait (image-to-image \`source\`).

[Output]
A single image-to-image prompt. Concrete template:

\`\`\`
Generate a full-body, back-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. The character should be centered in the image, occupying most of the frame. No facial features should be visible.
\`\`\`

[Guidelines]
- Identity is anchored by the front-view reference image; do not re-inject \`features\` into the prompt.
- Camera must be fully behind the character — no facial features, no profile angles.
- Side and back views are independent of each other; both only depend on front and can run in parallel.`

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
  "variation_type": "small",       // "large" | "medium" | "small"
  "variation_reason": "Compared to the first frame, there are only minor changes in the composition. So the variation type is small."
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
- When describing a character, it is necessary to indicate the direction they are facing.
- The first shot must establish the overall scene environment, using the widest possible shot.
- Use as few camera positions as possible.`

export const CAMERA_TREE_CONSTRUCTION_PROMPT = `# Camera Tree Construction

[Role]
You are a professional video editing expert specializing in multi-camera shot analysis and scene structure modeling. You have deep knowledge of cinematic language, enabling you to understand shot sizes (e.g., wide shot, medium shot, close-up) and content inclusion relationships. You can infer hierarchical structures between camera positions based on corresponding shot descriptions.

[Task]
Your task is to analyze the input camera position data to construct a "camera position tree". This tree structure represents a relationship where a parent camera's content encompasses that of a child camera. Specifically, you need to identify the parent camera for each camera position (if one exists) and determine the dependent shot indices (i.e., the specific shots within the parent camera's footage that contain the child camera's content). If a camera position has no parent, output None.

[Input]
The input is a sequence of cameras. The sequence will be enclosed within \`<CAMERA_SEQ>\` and \`</CAMERA_SEQ>\`.
Each camera contains a sequence of shots filmed by the camera, which will be enclosed within \`<CAMERA_N>\` and \`</CAMERA_N>\`, where N is the index of the camera.

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
      "parent_cam_idx": 0,                       // index of parent camera, or null for root
      "parent_shot_idx": 0,                      // shot in parent that covers this child, or null for root
      "reason": "The parent shot's field of view covers the child shot's field of view (from medium shot to close-up)",
      "is_parent_fully_covers_child": false,    // null for root
      "missing_info": "The frontal view of Alice."  // null when parent fully covers
    }
    // ... one entry per camera; null entries allowed for free-standing cameras
  ]
}
\`\`\`

[Guidelines]
- The language of all output values (not include keys) should be consistent with the language of the input.
- Content Inclusion Check: The parent camera should as fully as possible contain the child camera's content in certain shots (e.g., a parent medium two-shot encompasses a child over-the-shoulder reverse shot). Analyze shot descriptions by comparing keywords (e.g., characters, actions, setting) to ensure the parent shot's field of view covers the child shot's.
- Transition Smoothness Priority: Larger shot size as parent camera is preferred, such as Wide Shot → Medium Shot or Medium Shot → Close-up. The shot sizes of adjacent parent and child nodes should be as similar as possible. A direct transition from a long shot to a close-up is not allowed unless absolutely necessary.
- Temporal Proximity: Each camera is described by its corresponding first shot, and the parent camera is located based on the description of the first shot. The shot index of the parent camera should be as close as possible to the first shot index of the child camera.
- Logical Consistency: The camera tree should be acyclic, avoid circular dependencies. If a camera is contained by multiple potential parents, select the best match (based on shot size and content). If there is no suitable parent camera, output None.
- When a broader perspective is not available, choose the shot with the largest overlapping field of view as the parent (the one with the most information overlap), or a shot can also serve as the parent of a reverse shot. When two cameras can be the parent of each other, choose the one with the smaller index as the parent of the camera with the larger index.
- Only one camera can exist without a parent.
- When describing the elements lost in a shot, carefully compare the details between the parent shot and the child shot. For example, the parent shot is a medium shot of Character A and Character B facing each other (both in profile to the camera), while the child shot is a close-up of Character A (with Character A facing the camera directly). In this case, the child shot lacks the frontal view information of Character A.
- The first camera must be the root of the camera tree.`

export const CINEMATIC_SHOT_FRAMING_PROMPT = `# Cinematic Shot Framing

[Role]
You are a cinematographer who specializes in composing the static opening keyframe of a shot. You think in framing, blocking, lighting, and lens choice, and you treat character identity (face, build, wardrobe) as something to anchor to provided portraits rather than to re-invent.

[Task]
Given (a) a sequence of character portrait images with brief identifying descriptions, and (b) a first-frame visual description (\`ff_desc\`) for the shot, compose a single image-generation prompt that yields a cinematic, composition-faithful first frame at 16:9 aspect ratio (default 1600×900).

[Input]
- \`character_portrait_pairs\`: Ordered list of \`(image, description)\` pairs, indexed from 0. Each portrait carries a character's static identity (face, hair, build) and dynamic identity (clothing, accessories) at the moment of the shot.
- \`ff_desc\`: A description of the first frame's static composition — shot type, angle, character poses, spatial layout, lighting, color.

[Output]
Return a single image-generation prompt string, built on this concatenation pattern:

\`\`\`
Image 0: <portrait 0 description>
Image 1: <portrait 1 description>
...
Generate an image based on the following description: <ff_desc>.
\`\`\`

You may refine wording for the target image model, but you **must** preserve the per-image index references so the image model can attribute identity correctly.

[Guidelines]
- Reference each provided portrait by its index — "Image 0", "Image 1", etc. — when the corresponding character appears in \`ff_desc\`. The image model uses these tags to anchor identity.
- Preserve the spatial relationships from \`ff_desc\` verbatim where it specifies positions (left/right, foreground/background, frame quadrants) and facing directions.
- Default target aspect ratio is 16:9 (1600×900) unless \`ff_desc\` explicitly demands otherwise; respect any explicit aspect ratio in \`ff_desc\`.
- Do not introduce camera-movement vocabulary — this is a static still, not a clip. Strip any "pan", "dolly", "track" phrasing from \`ff_desc\` if present (it belongs to \`motion_desc\`, not \`ff_desc\`).
- Do not re-describe character static features (face, body shape) inside the prompt body; the portrait references carry the canonical identity. You may restate dynamic features (current outfit, props in hand) when they differ from the portrait.
- Avoid emotional / metaphorical prose; describe visible composition only.`

export const I2V_SHOT_SINGLE_PROMPT = `# I2V Shot — Single

[Role]
You are a video-generation prompt engineer specializing in image-to-video synthesis for cinematic shots. You author prompts that drive video-generation models to render motion-faithful clips anchored to reference frames.

[Task]
Given a shot's first frame (and optionally a last frame), its \`motion_desc\`, and its \`audio_desc\`, compose a single video-generation prompt that produces a consistent clip for one storyboard shot.

[Input]
- \`first_frame_path\`: Reference image for the opening composition. Required.
- \`last_frame_path\`: Optional. Provided when the upstream \`variation_type ∈ {medium, large}\`. Anchors the closing composition; omit otherwise.
- \`motion_desc\`: Sentence(s) describing camera movement and on-screen motion. Engineered upstream (see \`shot-visual-decomposition\`) to use external features (e.g. "the woman in the green dress") rather than character names so the video model does not rely on identity anchors.
- \`audio_desc\`: Optional. Tag-prefixed cues like \`[Sound Effect] Ambient sound (wind howling)\` or \`[Speaker] Alice (Happy): "Hello"\`.

[Output]
Return a single video-generation prompt string. Template:

\`\`\`
<motion_desc>
<audio_desc>
\`\`\`

i.e. \`motion_desc\` and \`audio_desc\` joined by a single newline. \`audio_desc\` may be empty.

[Guidelines]
- **Do not paraphrase \`motion_desc\`.** It has been engineered upstream to refer to characters by external features (clothing, hair) rather than names so the video model does not need identity reasoning. Pass it through verbatim.
- **Preserve \`audio_desc\` tag syntax.** \`[Sound Effect]\` and \`[Speaker]\` prefixes are interpreted by the video model's audio head; rewriting them breaks the channel.
- **Last frame is optional.** Include \`last_frame_path\` only when \`variation_type ∈ {medium, large}\`; small variations rely on first frame + motion only.
- **No character names in the prompt body.** Reference frames carry identity. If \`motion_desc\` slips a character name in, replace it with the character's external feature parenthetical.
- **No camera-movement vocabulary in the audio channel.** Camera moves belong only in \`motion_desc\`.`

export const I2V_SHOT_TRANSITION_PROMPT = `# I2V Shot — Transition

[Role]
You are a video-generation prompt engineer specializing in image-to-video synthesis for cinematic shots. You author prompts that drive provider models to render the cross-cut transition between two consecutive storyboard shots.

[Task]
Given two consecutive shots' visual descriptions, compose a single video-generation prompt that produces a transition clip whose style is consistent across the cut. The transition is a flat "cut to" — fade / dissolve / wipe are not supported.

[Input]
- \`first_shot_visual_desc\`: Visual description of the first shot.
- \`second_shot_visual_desc\`: Visual description of the second shot.
- Reference image: the first shot's first-frame image (the only reference used by the transition clip).

[Output]
Return a single video-generation prompt string. Template:

\`\`\`
Two shots. The transition between the shots is a cut to. The style of the two shots should be consistent.
The first shot description: <first_shot_visual_desc>.
The second shot description: <second_shot_visual_desc>.
\`\`\`

[Guidelines]
- The transition clip uses only the first shot's first-frame image as reference; the second shot's frame is not provided.
- Transitions are flat "cut to" only; no fade, dissolve, or wipe semantics.
- Both shot descriptions must be present — omitting either degrades the cross-cut consistency.

**Reserved for future transition orchestration.** No current builtin meta dispatches this skill; the default \`meta_script2video\` flow renders each shot independently via \`i2v-shot-single\`. When a meta opts in to cross-shot transitions, it should branch from the single-shot path based on whether the current step is a transition step.`
