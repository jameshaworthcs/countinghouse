// Commit messages follow Conventional Commits (CONTRIBUTING.md, "Commit messages"). The git
// commit-msg hook (npm run hooks:install) and CI check them with this.

/** Lines are wrapped at 72 columns; a line with a URL may run on. */
const bodyWrap = (parsed, _when, max = 72) => {
  const lines = (parsed.body ?? '').split('\n').filter((l) => !/https?:\/\//.test(l));
  const long = lines.find((l) => l.length > max);
  return [!long, `body lines must be at most ${max} characters (a URL may run on): "${long?.slice(0, 40)}…"`];
};

/** Git trailers (Co-authored-by, Signed-off-by, Refs…) are not used: only a BREAKING CHANGE footer. */
const noTrailers = (parsed) => {
  const paragraphs = (parsed.raw ?? '').trim().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1].split('\n').filter((l) => l && !l.startsWith('#')) : [];
  const trailers = last.filter((l) => /^[A-Za-z][\w-]*: \S/.test(l) && !/^BREAKING[ -]CHANGE: /.test(l));
  const isTrailerBlock = last.length > 0 && last.every((l) => /^[A-Za-z][\w-]*: \S/.test(l) || /^\s/.test(l));
  return [!(isTrailerBlock && trailers.length), `no trailers (${trailers.map((t) => t.split(':')[0]).join(', ')}): only a BREAKING CHANGE footer`];
};

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [{ rules: { 'body-wrap': bodyWrap, 'no-trailers': noTrailers } }],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'build', 'ci', 'chore', 'style', 'revert']],
    'scope-enum': [
      2,
      'always',
      ['import', 'pay', 'tax', 'investments', 'analytics', 'projections', 'records', 'agents', 'ask', 'models', 'proposals', 'sessions', 'audit', 'auth', 'security', 'store', 'web', 'charts', 'deploy', 'eval', 'demo', 'deps'],
    ],
    'header-max-length': [2, 'always', 72],
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
    'body-max-line-length': [0],
    'footer-max-line-length': [2, 'always', 72],
    'body-wrap': [2, 'always', 72],
    'no-trailers': [2, 'always'],
  },
};
