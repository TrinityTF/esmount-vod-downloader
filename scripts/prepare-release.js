// Used by .github/workflows/release.yml before building:
//   * sets the version to <major>.<minor>.<build number> (so every push is a newer version)
//   * writes build/release-notes.md from the commits since the previous release
// To start a new major/minor line, change "version" in package.json (e.g. to 1.1.0).
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const build = process.argv[2];
if (!/^\d+$/.test(build || '')) {
  console.error('Usage: node scripts/prepare-release.js <build number>');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [major, minor] = pkg.version.split('.');
pkg.version = `${major}.${minor}.${build}`;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const previousTag = git('describe --tags --abbrev=0');
const commits = git(`log ${previousTag ? `${previousTag}..HEAD` : 'HEAD'} --no-merges --format=%s -n 30`)
  .split('\n')
  .filter(Boolean);
const notes = commits.length ? commits.map((subject) => `- ${subject}`).join('\n') : '- Improvements and fixes';
fs.writeFileSync(path.join(root, 'build', 'release-notes.md'), `${notes}\n`);

console.log(`Version ${pkg.version}`);
console.log(notes);
