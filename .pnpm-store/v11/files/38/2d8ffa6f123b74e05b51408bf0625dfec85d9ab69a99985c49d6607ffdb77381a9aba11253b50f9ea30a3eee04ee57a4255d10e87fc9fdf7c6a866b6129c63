Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const types = require('../../../types.js');
const onHidden = require('./onHidden.js');
const runOnce = require('./runOnce.js');

/*
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


/**
 * Runs the passed callback during the next idle period, or immediately
 * if the browser's visibility state is (or becomes) hidden.
 */
const whenIdle = (cb) => {
  const rIC = types.WINDOW.requestIdleCallback || types.WINDOW.setTimeout;

  let handle = -1;
  // eslint-disable-next-line no-param-reassign
  cb = runOnce.runOnce(cb) ;
  // If the document is hidden, run the callback immediately, otherwise
  // race an idle callback with the next `visibilitychange` event.
  if (types.WINDOW.document?.visibilityState === 'hidden') {
    cb();
  } else {
    handle = rIC(cb);
    onHidden.onHidden(cb);
  }
  return handle;
};

exports.whenIdle = whenIdle;
//# sourceMappingURL=whenIdle.js.map
