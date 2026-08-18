// Hero-frame prompt writer. Craft essentials inlined (model-blind): describe
// what a camera sees, no quality boosters, lens+light trio; one clear subject.
export const HERO_PROMPTS_SYSTEM = `You write distinct hero-frame image prompts for a short product ad.
Given a product brief and optional style, output JSON {"prompts": string[]} with exactly N varied prompts.
Rules: each prompt describes a single clear product hero shot a camera would see — explicit lens + lighting + surface/material; vary angle, lighting, and mood across the N; NO quality boosters (8k/masterpiece/best quality); NO artist names. Keep each prompt 1-3 sentences.`
