import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Detect languages for a given root by marker files and extensions (shallow) */
export async function detectLanguages(rootPath: string): Promise<string[]> {
  const langs = new Set<string>();
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    const names = entries.map(e => e.name.toLowerCase());

    // JS/TS
    if (names.includes('tsconfig.json')) {
      // Prefer TypeScript if tsconfig is present; don't start JS separately
      langs.add('typescript');
    } else if (names.includes('package.json')) {
      langs.add('javascript');
    }

    // ESLint (flat config or legacy)
    if (
      names.includes('eslint.config.js') ||
      names.includes('eslint.config.mjs') ||
      names.includes('eslint.config.cjs') ||
      names.includes('.eslintrc') ||
      names.includes('.eslintrc.js') ||
      names.includes('.eslintrc.cjs') ||
      names.includes('.eslintrc.json')
    ) {
      langs.add('eslint');
    }

    // Python
    if (names.includes('pyproject.toml') || names.includes('requirements.txt')) {
      langs.add('python');
    }

    // Go
    if (names.includes('go.mod')) langs.add('go');

    // Rust
    if (names.includes('cargo.toml')) langs.add('rust');

    // C/C++
    if (names.includes('compile_commands.json')) {
      langs.add('c');
      langs.add('cpp');
    }

    // Java (very basic)
    if (names.includes('pom.xml') || names.includes('build.gradle') || names.includes('gradlew')) {
      langs.add('java');
    }
  } catch {
    // ignore
  }

  // Always include typescript/javascript if present in node projects
  return Array.from(langs);
}
