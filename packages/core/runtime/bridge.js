/**
 * EasyApp runtime bridge. Injected into every generated application.
 *
 * The native host injects `window.__easyappTransport(messageJson)` before this
 * script runs. Every call is re-checked against the permission list on the
 * native side; the checks here only exist to fail fast with a clear message.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later WITH Runtime-exception
 *
 * RUNTIME LIBRARY EXCEPTION
 *
 * This file is part of the EasyApp runtime that the compiler embeds into every
 * generated application. Linking or bundling this runtime with an independent
 * application (your HTML/CSS/JS bundle) does not by itself cause that
 * application to be covered by the GNU GPL. You may distribute generated
 * applications under terms of your choice, provided you comply with the GPL
 * for the runtime itself and keep this notice intact.
 *
 * This exception applies only to the runtime files that are copied into a
 * generated application (this bridge, the native hosts and cJSON). The
 * compiler proper remains under GPL-3.0-or-later without this exception.
 */
(function () {
  'use strict';

  if (window.easyapp) return;

  var manifest = window.__EASYAPP_MANIFEST__ || { permissions: [], name: 'EasyApp' };
  var permissions = manifest.permissions || [];
  var pending = Object.create(null);
  var nextId = 1;

  function has(permission) {
    return permissions.indexOf(permission) !== -1;
  }

  function requirePermission(permission) {
    if (!has(permission)) {
      throw new Error(
        'Permission "' + permission + '" is not granted for this application. ' +
        'Add <!-- easyapp:permission ' + permission + ' --> to your HTML entry file ' +
        'or enable it in the compiler, then rebuild.'
      );
    }
  }

  window.__easyappResolve = function (id, ok, payload) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    if (ok) entry.resolve(payload);
    else entry.reject(new Error(payload && payload.message ? payload.message : String(payload)));
  };

  function invoke(method, params) {
    return new Promise(function (resolve, reject) {
      if (typeof window.__easyappTransport !== 'function') {
        reject(new Error('EasyApp native bridge is unavailable. Run this app inside the compiled binary.'));
        return;
      }
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        window.__easyappTransport(JSON.stringify({ id: id, method: method, params: params || {} }));
      } catch (err) {
        delete pending[id];
        reject(err);
      }
    });
  }

  function toBase64(data) {
    var bytes;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else throw new TypeError('Expected string, Uint8Array or ArrayBuffer');
    var chunk = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  var easyapp = {
    /** Manifest and granted permissions of the running application. */
    info: function () {
      return JSON.parse(JSON.stringify(manifest));
    },

    hasPermission: has,

    /** Small persistent key/value store. Always available, scoped to the app. */
    storage: {
      get: function (key) { return invoke('storage.get', { key: String(key) }); },
      set: function (key, value) { return invoke('storage.set', { key: String(key), value: String(value) }); },
      remove: function (key) { return invoke('storage.remove', { key: String(key) }); },
      keys: function () { return invoke('storage.keys', {}); },
    },

    /**
     * Private application files. Always available and sandboxed; this is not
     * the shared device storage, so no `files` permission is needed.
     */
    privateFiles: {
      read: function (path) {
        return invoke('private.read', { path: String(path) }).then(function (r) { return fromBase64(r.data); });
      },
      readText: function (path) {
        return invoke('private.read', { path: String(path) }).then(function (r) { return new TextDecoder().decode(fromBase64(r.data)); });
      },
      write: function (path, data) { return invoke('private.write', { path: String(path), data: toBase64(data) }); },
      list: function (path) { return invoke('private.list', { path: String(path || '') }); },
      remove: function (path) { return invoke('private.remove', { path: String(path) }); },
    },

    /** Shared device storage. Requires the `files` permission. */
    files: {
      /** Open a system picker and return { name, data: Uint8Array }. */
      import: function (options) {
        requirePermission('files');
        return invoke('files.import', options || {}).then(function (r) {
          if (!r) return null;
          return { name: r.name, data: fromBase64(r.data) };
        });
      },
      /** Open a system save dialog and write bytes to the chosen location. */
      export: function (name, data) {
        requirePermission('files');
        return invoke('files.export', { name: String(name), data: toBase64(data) });
      },
      importText: function (options) {
        return easyapp.files.import(options).then(function (r) {
          return r ? { name: r.name, text: new TextDecoder().decode(r.data) } : null;
        });
      },
      exportText: function (name, text) {
        return easyapp.files.export(name, text);
      },
    },

    /**
     * Native HTTP client. Requires the `internet` permission.
     * Unlike fetch() it is not restricted by CORS, because the request is
     * performed by the host process rather than the web view.
     */
    fetch: function (url, options) {
      requirePermission('internet');
      options = options || {};
      var params = {
        url: String(url),
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 30000,
      };
      if (options.body !== undefined && options.body !== null) {
        params.body = typeof options.body === 'string' ? options.body : toBase64(options.body);
        params.bodyEncoding = typeof options.body === 'string' ? 'utf8' : 'base64';
      }
      return invoke('net.request', params).then(function (r) {
        var bytes = r.body ? fromBase64(r.body) : new Uint8Array(0);
        return {
          status: r.status,
          statusText: r.statusText || '',
          headers: r.headers || {},
          ok: r.status >= 200 && r.status < 300,
          arrayBuffer: function () { return Promise.resolve(bytes.buffer); },
          bytes: function () { return Promise.resolve(bytes); },
          text: function () { return Promise.resolve(new TextDecoder().decode(bytes)); },
          json: function () { return Promise.resolve(JSON.parse(new TextDecoder().decode(bytes))); },
        };
      });
    },

    /** Write a line to the host log (logcat / stderr / debug console). */
    log: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i += 1) {
        parts.push(typeof arguments[i] === 'string' ? arguments[i] : JSON.stringify(arguments[i]));
      }
      return invoke('app.log', { message: parts.join(' ') });
    },

    /** Close the application window. */
    exit: function () { return invoke('app.exit', {}); },
  };

  window.easyapp = easyapp;
})();
