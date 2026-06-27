import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set([
  '.git',
  '.claude',
  'node_modules',
  'sop-sample-training-data',
  'coverage',
  'dist',
  'build',
]);

const allowedFiles = new Set(['.env.example']);
const fileExtensions = new Set(['.html', '.js', '.json', '.md', '.sql', '.toml', '.yml', '.yaml']);
const riskyPatterns = [
  /postgresql:\/\/[^:\s]+:[^@\s]+@/i,
  /SUPABASE_SERVICE(?:_ROLE)?_KEY\s*=\s*\S+/i,
  /GEMINI_API_KEY\s*=\s*\S+/i,
  /VLLM_KEY\s*=\s*\S+/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const relativePath = path.relative(root, fullPath).replaceAll(path.sep, '/');
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      if (!ignoredDirs.has(entry)) walk(fullPath, files);
      continue;
    }

    if (entry.startsWith('.env') && entry !== '.env.example') continue;
    if (!fileExtensions.has(path.extname(entry)) && !entry.startsWith('.env')) continue;
    if (allowedFiles.has(relativePath)) continue;
    files.push(fullPath);
  }
  return files;
}

const findings = [];
for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (riskyPatterns.some(pattern => pattern.test(line))) {
      findings.push(`${path.relative(root, file)}:${index + 1}`);
    }
  });
}

if (findings.length) {
  console.error('Potential secrets found:');
  findings.forEach(finding => console.error(`- ${finding}`));
  process.exit(1);
}

console.log('No obvious secrets found in publishable files.');
