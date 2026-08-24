import { Worker } from 'node:worker_threads';
import { defineIntegration, logger } from '@sentry/core';
import { isDebuggerEnabled } from '../../utils/debug.js';
import { LOCAL_VARIABLES_KEY, functionNamesMatch } from './common.js';

// This string is a placeholder that gets overwritten with the worker code.
const base64WorkerScript = 'LyohIEBzZW50cnkvbm9kZSA5LjIyLjAgKGNjYWJmYzIpIHwgaHR0cHM6Ly9naXRodWIuY29tL2dldHNlbnRyeS9zZW50cnktamF2YXNjcmlwdCAqLwppbXBvcnR7U2Vzc2lvbiBhcyBlfWZyb20ibm9kZTppbnNwZWN0b3IvcHJvbWlzZXMiO2ltcG9ydHt3b3JrZXJEYXRhIGFzIHR9ZnJvbSJub2RlOndvcmtlcl90aHJlYWRzIjtjb25zdCBuPSJ1bmRlZmluZWQiPT10eXBlb2YgX19TRU5UUllfREVCVUdfX3x8X19TRU5UUllfREVCVUdfXyxvPSI5LjIyLjAiLGk9Z2xvYmFsVGhpcztjb25zdCBhPVsiZGVidWciLCJpbmZvIiwid2FybiIsImVycm9yIiwibG9nIiwiYXNzZXJ0IiwidHJhY2UiXSxzPXt9O2Z1bmN0aW9uIGMoZSl7aWYoISgiY29uc29sZSJpbiBpKSlyZXR1cm4gZSgpO2NvbnN0IHQ9aS5jb25zb2xlLG49e30sbz1PYmplY3Qua2V5cyhzKTtvLmZvckVhY2goKGU9Pntjb25zdCBvPXNbZV07bltlXT10W2VdLHRbZV09b30pKTt0cnl7cmV0dXJuIGUoKX1maW5hbGx5e28uZm9yRWFjaCgoZT0+e3RbZV09bltlXX0pKX19IWZ1bmN0aW9uKGUsdCxuPWkpe2NvbnN0IGE9bi5fX1NFTlRSWV9fPW4uX19TRU5UUllfX3x8e30scz1hW29dPWFbb118fHt9O3NbZV18fChzW2VdPXQoKSl9KCJsb2dnZXIiLChmdW5jdGlvbigpe2xldCBlPSExO2NvbnN0IHQ9e2VuYWJsZTooKT0+e2U9ITB9LGRpc2FibGU6KCk9PntlPSExfSxpc0VuYWJsZWQ6KCk9PmV9O3JldHVybiBuP2EuZm9yRWFjaCgobj0+e3Rbbl09KC4uLnQpPT57ZSYmYygoKCk9PntpLmNvbnNvbGVbbl0oYFNlbnRyeSBMb2dnZXIgWyR7bn1dOmAsLi4udCl9KSl9fSkpOmEuZm9yRWFjaCgoZT0+e3RbZV09KCk9Pnt9fSkpLHR9KSk7Y29uc3Qgcj0iX19TRU5UUllfRVJST1JfTE9DQUxfVkFSSUFCTEVTX18iO2NvbnN0IHU9dDtmdW5jdGlvbiBsKC4uLmUpe3UuZGVidWcmJmMoKCgpPT5jb25zb2xlLmxvZygiW0xvY2FsVmFyaWFibGVzIFdvcmtlcl0iLC4uLmUpKSl9YXN5bmMgZnVuY3Rpb24gZihlLHQsbixvKXtjb25zdCBpPWF3YWl0IGUucG9zdCgiUnVudGltZS5nZXRQcm9wZXJ0aWVzIix7b2JqZWN0SWQ6dCxvd25Qcm9wZXJ0aWVzOiEwfSk7b1tuXT1pLnJlc3VsdC5maWx0ZXIoKGU9PiJsZW5ndGgiIT09ZS5uYW1lJiYhaXNOYU4ocGFyc2VJbnQoZS5uYW1lLDEwKSkpKS5zb3J0KCgoZSx0KT0+cGFyc2VJbnQoZS5uYW1lLDEwKS1wYXJzZUludCh0Lm5hbWUsMTApKSkubWFwKChlPT5lLnZhbHVlPy52YWx1ZSkpfWFzeW5jIGZ1bmN0aW9uIGcoZSx0LG4sbyl7Y29uc3QgaT1hd2FpdCBlLnBvc3QoIlJ1bnRpbWUuZ2V0UHJvcGVydGllcyIse29iamVjdElkOnQsb3duUHJvcGVydGllczohMH0pO29bbl09aS5yZXN1bHQubWFwKChlPT5bZS5uYW1lLGUudmFsdWU/LnZhbHVlXSkpLnJlZHVjZSgoKGUsW3Qsbl0pPT4oZVt0XT1uLGUpKSx7fSl9ZnVuY3Rpb24gZChlLHQpe2UudmFsdWUmJigidmFsdWUiaW4gZS52YWx1ZT92b2lkIDA9PT1lLnZhbHVlLnZhbHVlfHxudWxsPT09ZS52YWx1ZS52YWx1ZT90W2UubmFtZV09YDwke2UudmFsdWUudmFsdWV9PmA6dFtlLm5hbWVdPWUudmFsdWUudmFsdWU6ImRlc2NyaXB0aW9uImluIGUudmFsdWUmJiJmdW5jdGlvbiIhPT1lLnZhbHVlLnR5cGU/dFtlLm5hbWVdPWA8JHtlLnZhbHVlLmRlc2NyaXB0aW9ufT5gOiJ1bmRlZmluZWQiPT09ZS52YWx1ZS50eXBlJiYodFtlLm5hbWVdPSI8dW5kZWZpbmVkPiIpKX1hc3luYyBmdW5jdGlvbiBiKGUsdCl7Y29uc3Qgbj1hd2FpdCBlLnBvc3QoIlJ1bnRpbWUuZ2V0UHJvcGVydGllcyIse29iamVjdElkOnQsb3duUHJvcGVydGllczohMH0pLG89e307Zm9yKGNvbnN0IHQgb2Ygbi5yZXN1bHQpaWYodC52YWx1ZT8ub2JqZWN0SWQmJiJBcnJheSI9PT10LnZhbHVlLmNsYXNzTmFtZSl7Y29uc3Qgbj10LnZhbHVlLm9iamVjdElkO2F3YWl0IGYoZSxuLHQubmFtZSxvKX1lbHNlIGlmKHQudmFsdWU/Lm9iamVjdElkJiYiT2JqZWN0Ij09PXQudmFsdWUuY2xhc3NOYW1lKXtjb25zdCBuPXQudmFsdWUub2JqZWN0SWQ7YXdhaXQgZyhlLG4sdC5uYW1lLG8pfWVsc2UgdC52YWx1ZSYmZCh0LG8pO3JldHVybiBvfWxldCBwOyhhc3luYyBmdW5jdGlvbigpe2NvbnN0IHQ9bmV3IGU7dC5jb25uZWN0VG9NYWluVGhyZWFkKCksbCgiQ29ubmVjdGVkIHRvIG1haW4gdGhyZWFkIik7bGV0IG49ITE7dC5vbigiRGVidWdnZXIucmVzdW1lZCIsKCgpPT57bj0hMX0pKSx0Lm9uKCJEZWJ1Z2dlci5wYXVzZWQiLChlPT57bj0hMCxhc3luYyBmdW5jdGlvbihlLHtyZWFzb246dCxkYXRhOntvYmplY3RJZDpufSxjYWxsRnJhbWVzOm99KXtpZigiZXhjZXB0aW9uIiE9PXQmJiJwcm9taXNlUmVqZWN0aW9uIiE9PXQpcmV0dXJuO2lmKHA/LigpLG51bGw9PW4pcmV0dXJuO2NvbnN0IGk9W107Zm9yKGxldCB0PTA7dDxvLmxlbmd0aDt0Kyspe2NvbnN0e3Njb3BlQ2hhaW46bixmdW5jdGlvbk5hbWU6YSx0aGlzOnN9PW9bdF0sYz1uLmZpbmQoKGU9PiJsb2NhbCI9PT1lLnR5cGUpKSxyPSJnbG9iYWwiIT09cy5jbGFzc05hbWUmJnMuY2xhc3NOYW1lP2Ake3MuY2xhc3NOYW1lfS4ke2F9YDphO2lmKHZvaWQgMD09PWM/Lm9iamVjdC5vYmplY3RJZClpW3RdPXtmdW5jdGlvbjpyfTtlbHNle2NvbnN0IG49YXdhaXQgYihlLGMub2JqZWN0Lm9iamVjdElkKTtpW3RdPXtmdW5jdGlvbjpyLHZhcnM6bn19fWF3YWl0IGUucG9zdCgiUnVudGltZS5jYWxsRnVuY3Rpb25PbiIse2Z1bmN0aW9uRGVjbGFyYXRpb246YGZ1bmN0aW9uKCkgeyB0aGlzLiR7cn0gPSB0aGlzLiR7cn0gfHwgJHtKU09OLnN0cmluZ2lmeShpKX07IH1gLHNpbGVudDohMCxvYmplY3RJZDpufSksYXdhaXQgZS5wb3N0KCJSdW50aW1lLnJlbGVhc2VPYmplY3QiLHtvYmplY3RJZDpufSl9KHQsZS5wYXJhbXMpLnRoZW4oKGFzeW5jKCk9PntuJiZhd2FpdCB0LnBvc3QoIkRlYnVnZ2VyLnJlc3VtZSIpfSksKGFzeW5jIGU9PntuJiZhd2FpdCB0LnBvc3QoIkRlYnVnZ2VyLnJlc3VtZSIpfSkpfSkpLGF3YWl0IHQucG9zdCgiRGVidWdnZXIuZW5hYmxlIik7Y29uc3Qgbz0hMSE9PXUuY2FwdHVyZUFsbEV4Y2VwdGlvbnM7aWYoYXdhaXQgdC5wb3N0KCJEZWJ1Z2dlci5zZXRQYXVzZU9uRXhjZXB0aW9ucyIse3N0YXRlOm8/ImFsbCI6InVuY2F1Z2h0In0pLG8pe2NvbnN0IGU9dS5tYXhFeGNlcHRpb25zUGVyU2Vjb25kfHw1MDtwPWZ1bmN0aW9uKGUsdCxuKXtsZXQgbz0wLGk9NSxhPTA7cmV0dXJuIHNldEludGVydmFsKCgoKT0+ezA9PT1hP28+ZSYmKGkqPTIsbihpKSxpPjg2NDAwJiYoaT04NjQwMCksYT1pKTooYS09MSwwPT09YSYmdCgpKSxvPTB9KSwxZTMpLnVucmVmKCksKCk9PntvKz0xfX0oZSwoYXN5bmMoKT0+e2woIlJhdGUtbGltaXQgbGlmdGVkLiIpLGF3YWl0IHQucG9zdCgiRGVidWdnZXIuc2V0UGF1c2VPbkV4Y2VwdGlvbnMiLHtzdGF0ZToiYWxsIn0pfSksKGFzeW5jIGU9PntsKGBSYXRlLWxpbWl0IGV4Y2VlZGVkLiBEaXNhYmxpbmcgY2FwdHVyaW5nIG9mIGNhdWdodCBleGNlcHRpb25zIGZvciAke2V9IHNlY29uZHMuYCksYXdhaXQgdC5wb3N0KCJEZWJ1Z2dlci5zZXRQYXVzZU9uRXhjZXB0aW9ucyIse3N0YXRlOiJ1bmNhdWdodCJ9KX0pKX19KSgpLmNhdGNoKChlPT57bCgiRmFpbGVkIHRvIHN0YXJ0IGRlYnVnZ2VyIixlKX0pKSxzZXRJbnRlcnZhbCgoKCk9Pnt9KSwxZTQpOw==';

function log(...args) {
  logger.log('[LocalVariables]', ...args);
}

/**
 * Adds local variables to exception frames
 */
const localVariablesAsyncIntegration = defineIntegration(((
  integrationOptions = {},
) => {
  function addLocalVariablesToException(exception, localVariables) {
    // Filter out frames where the function name is `new Promise` since these are in the error.stack frames
    // but do not appear in the debugger call frames
    const frames = (exception.stacktrace?.frames || []).filter(frame => frame.function !== 'new Promise');

    for (let i = 0; i < frames.length; i++) {
      // Sentry frames are in reverse order
      const frameIndex = frames.length - i - 1;

      const frameLocalVariables = localVariables[i];
      const frame = frames[frameIndex];

      if (!frame || !frameLocalVariables) {
        // Drop out if we run out of frames to match up
        break;
      }

      if (
        // We need to have vars to add
        frameLocalVariables.vars === undefined ||
        // We're not interested in frames that are not in_app because the vars are not relevant
        frame.in_app === false ||
        // The function names need to match
        !functionNamesMatch(frame.function, frameLocalVariables.function)
      ) {
        continue;
      }

      frame.vars = frameLocalVariables.vars;
    }
  }

  function addLocalVariablesToEvent(event, hint) {
    if (
      hint.originalException &&
      typeof hint.originalException === 'object' &&
      LOCAL_VARIABLES_KEY in hint.originalException &&
      Array.isArray(hint.originalException[LOCAL_VARIABLES_KEY])
    ) {
      for (const exception of event.exception?.values || []) {
        addLocalVariablesToException(exception, hint.originalException[LOCAL_VARIABLES_KEY]);
      }

      hint.originalException[LOCAL_VARIABLES_KEY] = undefined;
    }

    return event;
  }

  async function startInspector() {
    // We load inspector dynamically because on some platforms Node is built without inspector support
    const inspector = await import('node:inspector');
    if (!inspector.url()) {
      inspector.open(0);
    }
  }

  function startWorker(options) {
    const worker = new Worker(new URL(`data:application/javascript;base64,${base64WorkerScript}`), {
      workerData: options,
      // We don't want any Node args to be passed to the worker
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: undefined },
    });

    process.on('exit', () => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      worker.terminate();
    });

    worker.once('error', (err) => {
      log('Worker error', err);
    });

    worker.once('exit', (code) => {
      log('Worker exit', code);
    });

    // Ensure this thread can't block app exit
    worker.unref();
  }

  return {
    name: 'LocalVariablesAsync',
    async setup(client) {
      const clientOptions = client.getOptions();

      if (!clientOptions.includeLocalVariables) {
        return;
      }

      if (await isDebuggerEnabled()) {
        logger.warn('Local variables capture has been disabled because the debugger was already enabled');
        return;
      }

      const options = {
        ...integrationOptions,
        debug: logger.isEnabled(),
      };

      startInspector().then(
        () => {
          try {
            startWorker(options);
          } catch (e) {
            logger.error('Failed to start worker', e);
          }
        },
        e => {
          logger.error('Failed to start inspector', e);
        },
      );
    },
    processEvent(event, hint) {
      return addLocalVariablesToEvent(event, hint);
    },
  };
}) );

export { base64WorkerScript, localVariablesAsyncIntegration };
//# sourceMappingURL=local-variables-async.js.map
