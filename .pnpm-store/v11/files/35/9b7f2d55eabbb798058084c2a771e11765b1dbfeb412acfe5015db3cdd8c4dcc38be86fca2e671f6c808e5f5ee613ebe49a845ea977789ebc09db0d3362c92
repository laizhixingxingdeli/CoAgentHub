import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineIntegration, logger } from '@sentry/core';
import { DEBUG_BUILD } from '../debug-build.js';
import { isCjs } from '../utils/commonjs.js';

let moduleCache;

const INTEGRATION_NAME = 'Modules';

const _modulesIntegration = (() => {
  // This integration only works in CJS contexts
  if (!isCjs()) {
    DEBUG_BUILD &&
      logger.warn(
        'modulesIntegration only works in CommonJS (CJS) environments. Remove this integration if you are using ESM.',
      );
    return {
      name: INTEGRATION_NAME,
    };
  }

  return {
    name: INTEGRATION_NAME,
    processEvent(event) {
      event.modules = {
        ...event.modules,
        ..._getModules(),
      };

      return event;
    },
  };
}) ;

/**
 * Add node modules / packages to the event.
 *
 * Only works in CommonJS (CJS) environments.
 */
const modulesIntegration = defineIntegration(_modulesIntegration);

/** Extract information about paths */
function getPaths() {
  try {
    return require.cache ? Object.keys(require.cache ) : [];
  } catch (e) {
    return [];
  }
}

/** Extract information about package.json modules */
function collectModules()

 {
  const mainPaths = require.main?.paths || [];
  const paths = getPaths();
  const infos

 = {};
  const seen

 = {};

  paths.forEach(path => {
    let dir = path;

    /** Traverse directories upward in the search of package.json file */
    const updir = () => {
      const orig = dir;
      dir = dirname(orig);

      if (!dir || orig === dir || seen[orig]) {
        return undefined;
      }
      if (mainPaths.indexOf(dir) < 0) {
        return updir();
      }

      const pkgfile = join(orig, 'package.json');
      seen[orig] = true;

      if (!existsSync(pkgfile)) {
        return updir();
      }

      try {
        const info = JSON.parse(readFileSync(pkgfile, 'utf8'))

;
        infos[info.name] = info.version;
      } catch (_oO) {
        // no-empty
      }
    };

    updir();
  });

  return infos;
}

/** Fetches the list of modules and the versions loaded by the entry file for your node.js app. */
function _getModules() {
  if (!moduleCache) {
    moduleCache = collectModules();
  }
  return moduleCache;
}

export { modulesIntegration };
//# sourceMappingURL=modules.js.map
