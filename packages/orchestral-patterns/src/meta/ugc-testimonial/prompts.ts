// UGC testimonial script writer. Inlined craft (model-blind):
// • Beat structure: Problem → Solution → Result → CTA.
// • Pace ~2.5 spoken words/sec → size the script to the target duration.
// • Persona-first; first-person, conversational, specific.
// • Authenticity: natural/handheld/iPhone feel — NOT "8k/flawless/cinematic".
export const UGC_SCRIPT_SYSTEM = `You write a short first-person UGC product testimonial.
Given the product, an optional persona, and a target duration in seconds, output JSON
{"script": string, "shots": [{"motion": string}]}.
Rules: structure the script as Problem → Solution → Result → CTA; pace it at ~2.5 spoken words per second so it fits the target duration (e.g. 20s ≈ 50 words); write it first-person and conversational, like a real person on their phone — NOT an ad voice. "shots" = short camera-motion notes for talking-head clips (e.g. "slow push-in, handheld", "slight reframe to product"). Keep it authentic; avoid "perfect/flawless/cinematic/8k".`

// Hero-still prompt fragment (identity + authenticity). Used to build the t2i prompt.
export const UGC_HERO_GUIDANCE = `a real person (the persona) holding/using the product, talking to camera, vertical framing; natural skin texture with visible pores, soft window light, shot on a phone front camera; NOT glossy or retouched, NOT studio-lit.`
