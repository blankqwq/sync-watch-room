export function plainText(value, limit = 500) {
  let text = String(value || "").replace(/<[^>]*>/g, " ");
  const entities = { amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'" };
  for (let pass = 0; pass < 2; pass += 1) text = text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);/gi, (match, entity) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}
