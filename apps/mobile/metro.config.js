const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    // Ensure only one copy of react / react-native
    extraNodeModules: {
      react: path.resolve(projectRoot, 'node_modules/react'),
      'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
    },
    // Map .js imports to .ts sources (shared package uses ESM .js extensions)
    sourceExts: ['ts', 'tsx', 'js', 'jsx', 'json', 'cjs', 'mjs'],
    // Resolve workspace packages
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === '@bags-index/shared') {
        return {
          filePath: path.resolve(monorepoRoot, 'packages/shared/src/index.ts'),
          type: 'sourceFile',
        };
      }
      // Handle .js → .ts resolution for workspace packages
      if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
        const absPath = path.resolve(path.dirname(context.originModulePath), moduleName);
        if (absPath.includes('packages/shared/src') && moduleName.endsWith('.js')) {
          const tsPath = absPath.replace(/\.js$/, '.ts');
          try {
            require('fs').accessSync(tsPath);
            return { filePath: tsPath, type: 'sourceFile' };
          } catch {}
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
