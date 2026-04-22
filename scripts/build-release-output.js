const fs = require("fs");
const path = require("path");

const releaseRepoRoot = path.resolve(__dirname, "..");
const contentRepoArg = process.argv[2];

if (!contentRepoArg) {
  console.error("Usage: node scripts/build-release-output.js <path-to-content-repo>");
  process.exit(1);
}

const contentRepoRoot = path.resolve(releaseRepoRoot, contentRepoArg);
const contentTopicsDir = path.join(contentRepoRoot, "main", "topics");
const releaseAssetsRoot = releaseRepoRoot;
const distRoot = path.join(releaseRepoRoot, "dist");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed === "null") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return JSON.parse(trimmed.replace(/'/g, '"'));
  }
  return trimmed;
}

function parseYamlBlock(lines, startIndex, currentIndent) {
  const result = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const indent = line.match(/^ */)[0].length;
    if (indent < currentIndent) {
      break;
    }
    if (indent > currentIndent) {
      throw new Error(`Unexpected indentation in YAML near: ${line}`);
    }

    const trimmed = line.trim();
    const keyValue = trimmed.match(/^([^:]+):(.*)$/);
    if (!keyValue) {
      throw new Error(`Unsupported YAML line: ${line}`);
    }

    const key = keyValue[1].trim();
    const rest = keyValue[2].trim();

    if (!rest) {
      const nextLine = lines[index + 1] || "";
      const nextTrimmed = nextLine.trim();
      const nextIndent = nextLine.match(/^ */)[0].length;

      if (nextTrimmed.startsWith("- ")) {
        const listResult = [];
        index += 1;
        while (index < lines.length) {
          const listLine = lines[index];
          const listIndent = listLine.match(/^ */)[0].length;
          const listTrimmed = listLine.trim();
          if (!listTrimmed) {
            index += 1;
            continue;
          }
          if (listIndent < currentIndent + 2 || !listTrimmed.startsWith("- ")) {
            break;
          }
          const itemValue = listTrimmed.slice(2).trim();
          if (itemValue.includes(":")) {
            const item = {};
            const firstMatch = itemValue.match(/^([^:]+):(.*)$/);
            item[firstMatch[1].trim()] = parseScalar(firstMatch[2].trim());
            index += 1;
            while (index < lines.length) {
              const nestedLine = lines[index];
              const nestedIndent = nestedLine.match(/^ */)[0].length;
              const nestedTrimmed = nestedLine.trim();
              if (!nestedTrimmed) {
                index += 1;
                continue;
              }
              if (nestedIndent <= listIndent) {
                break;
              }
              const nestedMatch = nestedTrimmed.match(/^([^:]+):(.*)$/);
              item[nestedMatch[1].trim()] = parseScalar(nestedMatch[2].trim());
              index += 1;
            }
            listResult.push(item);
            continue;
          }
          listResult.push(parseScalar(itemValue));
          index += 1;
        }
        result[key] = listResult;
        continue;
      }

      if (nextIndent > currentIndent) {
        const nested = parseYamlBlock(lines, index + 1, currentIndent + 2);
        result[key] = nested.value;
        index = nested.nextIndex;
        continue;
      }

      result[key] = {};
      index += 1;
      continue;
    }

    result[key] = parseScalar(rest);
    index += 1;
  }

  return { value: result, nextIndex: index };
}

function parseYaml(source) {
  return parseYamlBlock(source.split("\n"), 0, 0).value;
}

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Missing frontmatter");
  }
  return { frontmatter: parseYaml(match[1]), body: match[2].trim() };
}

function loadCanonicalTopics() {
  if (!fs.existsSync(contentTopicsDir)) {
    throw new Error(`Cannot find canonical topics directory: ${contentTopicsDir}`);
  }

  const topicsById = new Map();
  for (const fileName of fs.readdirSync(contentTopicsDir)) {
    if (!fileName.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(contentTopicsDir, fileName);
    const { frontmatter, body } = parseFrontmatter(readText(filePath));
    if (topicsById.has(frontmatter.topic_id)) {
      throw new Error(`Duplicate topic_id '${frontmatter.topic_id}' in content repo`);
    }
    topicsById.set(frontmatter.topic_id, {
      topicId: frontmatter.topic_id,
      slug: fileName.replace(/\.md$/, ""),
      path: filePath,
      frontmatter,
      body,
    });
  }
  return topicsById;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue < rightValue) {
      return -1;
    }
    if (leftValue > rightValue) {
      return 1;
    }
  }
  return 0;
}

function releaseMatchesRange(release, range) {
  if (range.endsWith("+")) {
    return compareVersions(release, range.slice(0, -1)) >= 0;
  }
  if (range.includes("-")) {
    const [start, end] = range.split("-");
    return compareVersions(release, start) >= 0 && compareVersions(release, end) <= 0;
  }
  return release === range;
}

function renderVersionBlocks(markdown, release) {
  return markdown
    .replace(/:::version range="([^"]+)"\n([\s\S]*?)\n:::/g, (_match, range, content) => {
      return releaseMatchesRange(release, range) ? content.trim() : "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function validateRelease(topicsById, releaseDirName, manifest, toc) {
  const errors = [];
  const manifestTopicIds = manifest.topics || [];
  const tocTopicIds = new Set();

  for (const topicId of manifestTopicIds) {
    if (!topicsById.has(topicId)) {
      errors.push(`Manifest topic_id '${topicId}' in ${releaseDirName} does not exist in content repo`);
    }
  }

  for (const section of toc.sections || []) {
    for (const topicId of section.topics || []) {
      tocTopicIds.add(topicId);
      if (!topicsById.has(topicId)) {
        errors.push(`TOC topic_id '${topicId}' in ${releaseDirName} does not exist in content repo`);
      }
      if (!manifestTopicIds.includes(topicId)) {
        errors.push(`TOC topic_id '${topicId}' in ${releaseDirName} is missing from manifests/book.yml`);
      }
    }
  }

  for (const topicId of manifestTopicIds) {
    if (!tocTopicIds.has(topicId)) {
      errors.push(`Manifest topic_id '${topicId}' in ${releaseDirName} is missing from assets/toc.yml`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function buildRelease(topicsById, releaseDirName) {
  const releaseDir = path.join(releaseAssetsRoot, releaseDirName);
  const manifest = parseYaml(readText(path.join(releaseDir, "manifests", "book.yml")));
  const toc = parseYaml(readText(path.join(releaseDir, "assets", "toc.yml")));
  const releaseMetadata = parseYaml(readText(path.join(releaseDir, "assets", "release-metadata.yml")));
  const release = releaseMetadata.release;

  validateRelease(topicsById, releaseDirName, manifest, toc);

  const includedTopics = [];
  const skippedTopics = [];

  for (const topicId of manifest.topics || []) {
    const topic = topicsById.get(topicId);
    if ((topic.frontmatter.lifecycle?.applies_to || []).includes(release)) {
      includedTopics.push(topic);
    } else {
      skippedTopics.push({
        slug: topic.slug,
        reason: `Filtered out by lifecycle.applies_to for release ${release}`,
      });
    }
  }

  const outputDir = path.join(distRoot, release);
  ensureDir(outputDir);

  for (const topic of includedTopics) {
    fs.writeFileSync(path.join(outputDir, `${topic.slug}.md`), renderVersionBlocks(topic.body, release));
  }

  const tocSummary = (toc.sections || [])
    .map((section) => {
      const visible = (section.topics || [])
        .filter((topicId) => includedTopics.some((topic) => topic.topicId === topicId))
        .map((topicId) => topicsById.get(topicId)?.slug)
        .filter(Boolean);
      if (visible.length === 0) {
        return null;
      }
      return `- ${section.title}: ${visible.join(", ")}`;
    })
    .filter(Boolean)
    .join("\n");

  const index = [
    `# ${releaseMetadata.display_name}`,
    "",
    `Publish path: \`${releaseMetadata.publish_path}\``,
    `Status: \`${releaseMetadata.status}\``,
    `Latest: \`${releaseMetadata.is_latest}\``,
    "",
    "## Included topics",
    ...includedTopics.map((topic) => `- ${topic.slug} (${topic.topicId})`),
    "",
    "## Filtered topics",
    ...(skippedTopics.length ? skippedTopics.map((topic) => `- ${topic.slug}: ${topic.reason}`) : ["- none"]),
    "",
    "## TOC summary",
    tocSummary || "- no visible sections",
    "",
    "## Source mapping",
    `- Canonical repo: \`${contentRepoRoot}\``,
    `- Release repo: \`${releaseDir}\``,
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outputDir, "index.md"), index);
}

function main() {
  ensureDir(distRoot);
  const topicsById = loadCanonicalTopics();
  for (const entry of fs.readdirSync(releaseAssetsRoot)) {
    const candidate = path.join(releaseAssetsRoot, entry);
    if (!entry.startsWith("release-") || !fs.statSync(candidate).isDirectory()) {
      continue;
    }
    buildRelease(topicsById, entry);
  }
  console.log(`Built release outputs in ${distRoot}`);
}

main();
