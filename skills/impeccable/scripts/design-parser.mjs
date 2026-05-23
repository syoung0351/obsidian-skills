// Parse a DESIGN.md (Stitch-spec format) into a structured JSON model that
// the live-mode design-system panel can render. Deterministic, dependency-free.
//
// Two-layer: YAML frontmatter (machine-readable tokens) + markdown body
// (prose with six canonical H2 sections). When frontmatter is present, it's
// exposed on `model.frontmatter` alongside the prose-scraped sections;
// consumers can prefer frontmatter values and fall back to prose.

const CANONICAL_SECTIONS = [
  'Overview',
  'Colors',
  'Typography',
  'Elevation',
  'Components',
  "Do's and Don'ts",
];

// ---------- Frontmatter (Stitch YAML subset) ----------

function parseFrontmatter(md) {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: null, body: md };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { frontmatter: null, body: md };

  const yaml = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  try {
    return { frontmatter: parseYamlSubset(yaml), body };
  } catch {
    return { frontmatter: null, body: md };
  }
}

// Minimal YAML reader for the Stitch frontmatter subset: scalar maps with
// one level of nested objects (typography roles, components). Indent-based,
// 2-space convention. No arrays, no anchors, no multi-line scalars — Stitch's
// schema doesn't need them and accepting them would require a real YAML
// dependency we don't want to vendor.
function parseYamlSubset(yaml) {
  const lines = yaml.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (const raw of lines) {
    // Skip blanks and line-only comments. Don't strip inline comments:
    // unquoted hex values start with `#` and can't be safely distinguished
    // from a comment after whitespace.
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    const indent = raw.match(/^\s*/)[0].length;
    const content = raw.slice(indent);

    const colonIdx = findTopLevelColon(content);
    if (colonIdx === -1) continue;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const key = content.slice(0, colonIdx).trim();
    const rest = content.slice(colonIdx + 1).trim();
    const parent = stack[stack.length - 1].obj;

    if (rest === '') {
      const obj = {};
      parent[key] = obj;
      stack.push({ indent, obj });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

function findTopLevelColon(s) {
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== '\\') inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ':') {
      return i;
    }
  }
  return -1;
}

function parseScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const OKLCH_RE = /oklch\([^)]+\)/gi;
const RGBA_RE = /rgba?\([^)]+\)/gi;
const BOX_SHADOW_RE = /(?:box-shadow:\s*)?((?:-?\d[\w\d\s\-.,/()#%]*)+)/;
const NAMED_RULE_RE = /\*\*(The [^*]+?Rule)\.\*\*\s*(.+)/;

// ---------- Section splitting ----------

function splitSections(md) {
  const lines = md.split(/\r?\n/);
  let title = null;
  const sections = {};
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!title && line.startsWith('# ') && !line.startsWith('## ')) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    const h2 = line.match(/^##\s+(?:\d+\.\s*)?([^:\n]+?)(?::\s*(.+))?$/);
    if (h2) {
      const rawName = normalizeApostrophes(h2[1].trim());
      const subtitle = h2[2] ? h2[2].trim() : null;
      const canonical = matchCanonicalSection(rawName);
      if (canonical) {
        current = { name: canonical, subtitle, lines: [] };
        sections[canonical] = current;
        continue;
      }
      // non-canonical H2 — ignore but stop feeding into current
      current = null;
      continue;
    }

    if (current) current.lines.push(raw);
  }

  return { title, sections };
}

function normalizeApostrophes(s) {
  return s.replace(/[‘’]/g, "'");
}

function matchCanonicalSection(name) {
  const normalized = normalizeApostrophes(name).toLowerCase();
  // Exact match first
  for (const c of CANONICAL_SECTIONS) {
    if (normalizeApostrophes(c).toLowerCase() === normalized) return c;
  }
  // Keyword-contained match: "Overview & Creative North Star" -> "Overview",
  // "Elevation & Depth" -> "Elevation", etc.
  for (const c of CANONICAL_SECTIONS) {
    const key = normalizeApostrophes(c).toLowerCase();
    const pattern = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
    if (pattern.test(normalized)) return c;
  }
  return null;
}

// ---------- Subsection splitting (inside a canonical section) ----------

function splitSubsections(lines) {
  const subs = [];
  let current = { name: null, lines: [] };
  subs.push(current);

  for (const raw of lines) {
    const h3 = raw.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      current = { name: h3[1].trim(), lines: [] };
      subs.push(current);
      continue;
    }
    current.lines.push(raw);
  }

  return subs;
}

// ---------- Generic helpers ----------

function collectParagraphs(lines) {
  const paragraphs = [];
  let buf = [];
  const flush = () => {
    if (buf.length) {
      paragraphs.push(buf.join(' ').trim());
      buf = [];
    }
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') { flush(); continue; }
    // Horizontal rules (---, ***) and headings/bullets end a paragraph.
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); continue; }
    if (raw.startsWith('#') || raw.match(/^[-*]\s/)) { flush(); continue; }
    buf.push(trimmed);
  }
  flush();
  return paragraphs.filter(Boolean);
}

function collectBullets(lines) {
  const bullets = [];
  let current = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s+(.+)$/);
    if (m) {
      if (current) bullets.push(current);
      current = m[1];
      continue;
    }
    // continuation of a bullet (indented line)
    if (current && raw.match(/^\s{2,}\S/)) {
      current += ' ' + raw.trim();
      continue;
    }
    // blank line ends a bullet
    if (raw.trim() === '' && current) {
      bullets.push(current);
      current = null;
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

function stripBold(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1');
}

function extractNamedRules(lines) {
  const rules = [];
  const seen = new Set();

  // Style A (Impeccable): "**The X Rule.** body body body" — can span lines.
  const joined = lines.join('\n');
  const inlineStart = /\*\*(The [^*]+?Rule)\.\*\*/g;
  const inlineMatches = [];
  let m;
  while ((m = inlineStart.exec(joined)) !== null) {
    inlineMatches.push({ name: m[1], start: m.index, end: inlineStart.lastIndex });
  }
  for (let i = 0; i < inlineMatches.length; i++) {
    const mm = inlineMatches[i];
    const bodyEnd = i + 1 < inlineMatches.length ? inlineMatches[i + 1].start : joined.length;
    const body = joined
      .slice(mm.end, bodyEnd)
      .replace(/\n##[^\n]*$/s, '')
      .replace(/\n###[^\n]*$/s, '')
      .trim();
    const name = stripBold(mm.name).trim();
    seen.add(name.toLowerCase());
    rules.push({ name, body: stripBold(body) });
  }

  // Style B (Stitch): `### The "X" Rule` or `### The X Fallback`, body is the
  // bullets/paragraphs until the next heading. Accept Rule / Fallback / Principle.
  for (let i = 0; i < lines.length; i++) {
    const h3 = lines[i].match(/^###\s+(.+?)\s*$/);
    if (!h3) continue;
    const headerName = stripBold(h3[1]).replace(/["""]/g, '').trim();
    if (!/^The\b.*\b(Rule|Fallback|Principle)\b/i.test(headerName)) continue;
    if (seen.has(headerName.toLowerCase())) continue;

    const bodyLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s|^###\s/.test(lines[j])) break;
      bodyLines.push(lines[j]);
    }
    const body = stripBold(bodyLines.join('\n').replace(/\n+/g, ' ')).trim();
    if (body) {
      seen.add(headerName.toLowerCase());
      rules.push({ name: headerName, body });
    }
  }

  // Style C (Stitch bullet form): "*   **The Layering Principle:** body"
  // Colon/period lives inside the bold, so match "**...**" then inspect.
  for (const b of collectBullets(lines)) {
    const mm = b.match(/^\*\*([^*]+?)\*\*\s*(.+)$/);
    if (!mm) continue;
    const nameRaw = mm[1].replace(/[.:].\s*$/, '').replace(/["""]/g, '').trim();
    if (!/^The\b.+\b(Rule|Fallback|Principle)$/i.test(nameRaw)) continue;
    if (seen.has(nameRaw.toLowerCase())) continue;
    seen.add(nameRaw.toLowerCase());
    rules.push({ name: nameRaw, body: stripBold(mm[2]).trim() });
  }

  return rules;
}

// ---------- Per-section extractors ----------

function extractOverview(section) {
  if (!section) return null;
  const text = section.lines.join('\n');
  const northStar = text.match(/\*\*Creative North Star:\s*"([^"]+)"\*\*/);
  const keyChars = [];
  const keyCharMatch = text.match(/\*\*Key Characteristics:\*\*\s*\n([\s\S]+?)(?:\n##|\n###|$)/);
  if (keyCharMatch) {
    for (const line of keyCharMatch[1].split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.+)$/);
      if (m) keyChars.push(stripBold(m[1].trim()));
    }
  }

  // Philosophy paragraphs: everything that isn't a rule header or key-char block
  const paragraphs = collectParagraphs(section.lines).filter(
    (p) =>
      !p.startsWith('**Creative North Star') &&
      !p.startsWith('**Key Characteristics')
  );

  return {
    subtitle: section.subtitle,
    creativeNorthStar: northStar ? northStar[1] : null,
    philosophy: paragraphs,
    keyCharacteristics: keyChars,
  };
}

export function parseDesignMd(md) {
  const { frontmatter, body } = parseFrontmatter(md);
  const { title, sections } = splitSections(body);
  return {
    schemaVersion: 2,
    title,
    frontmatter,
    overview: extractOverview(sections['Overview']),
    colors: null,
    typography: null,
    elevation: null,
    components: null,
    dosDonts: null,
  };
}

export { assessCoverage };

function assessCoverage(model) {
  const report = {};
  report.overview = model.overview ? { northStar: Boolean(model.overview.creativeNorthStar), philosophy: model.overview.philosophy.length > 0, keyCharacteristics: model.overview.keyCharacteristics.length } : 'missing';
  return report;
}
