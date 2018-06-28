'use babel';

var fs = require('fs');
var path = require('path');

function atomGetStorageFolder () {
  if (atom.getStorageFolder != null) {
    return atom.getStorageFolder();
  } else {
    if (atom.storageFolder != null) return atom.storageFolder;

    var baseModulePath = path.dirname(path.dirname(require.resolve('atom')));
    var StorageFolder = require(baseModulePath + '/src/storage-folder');
    atom.storageFolder = new StorageFolder(atom.getConfigDirPath());

    return atom.storageFolder;
  }
}

exports.getStorageFolder = atomGetStorageFolder;

function saveCurrentState () {
  var paths = atom.project.getPaths();

  // Compute state key from path set
  var key = atom.getStateKey(paths);
  if (!key) return Promise.resolve(null);

  // Serialize state
  var state = atomSerialize();

  if (atom.stateStore != null) {
    // Atom 1.7+
    return atom.stateStore.save(key, state);
  } else {
    // Atom 1.5 to 1.6
    var store = atomGetStorageFolder();
    var keypath = store.pathForKey(key);
    return new Promise((resolve, reject) => {
      fs.writeFile(keypath, JSON.stringify(state), 'utf8', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

// shim atom.packages.serialize in <= 1.6
function packageStatesSerialize () {
  if (atom.packages.serialize != null) {
    return atom.packages.serialize();
  }

  atom.packages.getActivePackages().forEach((pack) => {
    var state;
    if (pack.serialize != null) state = pack.serialize();
    if (state) {
      atom.packages.setPackageState(pack.name, state);
    }
  })

  return atom.packages.packageStates;
}

// shim atom.serialize in <= 1.6
function atomSerialize () {
  var options = {isUnloading: true};
  if (atom.serialize != null) return atom.serialize(options);

  // Atom <= 1.6
  return {
    version: atom.constructor.version,
    project: atom.project.serialize(options),
    workspace: atom.workspace.serialize(),
    packageStates: packageStatesSerialize(),
    grammars: {grammarOverridesByPath: atom.grammars.grammarOverridesByPath},
    fullScreen: atom.isFullScreen(),
    windowDimensions: atom.windowDimensions
  };
}

exports.atomSerialize = atomSerialize;

function atomDeserialize (state) {
  // Atom >= 1.17
  // There is a new API for deserializing state into an active window
  if (atom.restoreStateIntoThisEnvironment) {
    return atom.restoreStateIntoThisEnvironment(state);
  }

  // Atom < 1.17
  if (atom.deserialize != null) return atom.deserialize(state);

  // Atom <= 1.6
  var grammarOverridesByPath = state.grammars
    ? state.grammars.grammarOverridesByPath
    : null;

  if (grammarOverridesByPath) {
    atom.grammars.grammarOverridesByPath = grammarOverridesByPath;
  }

  atom.setFullScreen(state.fullScreen);

  atom.packages.packageStates = state.packageStates || {};
  if (state.project != null) {
    atom.project.deserialize(state.project, atom.deserializers);
  }
  if (state.workspace != null) {
    atom.workspace.deserialize(state.workspace, atom.deserializers);
  }
}

function loadState (key) {
  if (atom.loadState != null) {
    return atom.loadState(key);
  }

  if (atom.stateStore != null) {
    // Atom 1.7+
    return atom.stateStore.load(key);
  }

  // Atom <= 1.6
  return Promise.resolve(atom.getStorageFolder().load(key));
}

function closeAllBuffers () {
  atom.project.getBuffers().forEach((buffer) => {
    if (buffer) buffer.release();
  });
}

function getTreeView () {
  var treeViewPack = atom.packages.getActivePackage('tree-view');
  var tv = (
    treeViewPack && treeViewPack.mainModule &&
    treeViewPack.mainModule.treeView);

  return tv;
}

// Switch to another project (in the same window)
exports.switch = function (paths) {
  var currentStateKey = atom.getStateKey(atom.project.getPaths());
  var newStateKey = atom.getStateKey(paths);

  return new Promise((resolve, reject) => {
    // Do nothing if keys are the same
    if (currentStateKey === newStateKey) return resolve();

    // Save current state
    saveCurrentState().then(() => {
      // Load state of the new project
      loadState(newStateKey).then((state) => {
        // HACK: Unload the active projects. This is _needed_ as of
        //    Atom 1.17 but apparently it should have been done earlier as
        //    well. I don't think there was any "bad" effects but eh,
        //    here we go I guess.
        atom.project.getPaths().forEach(path => {
          atom.project.removePath(path);
        });

        // Destroy the tabs
        // Fixes memory leak that was present in <= 3.x of this package
        var tabs = atom.packages.getActivePackage('tabs')
        if (tabs) {
          for (var i = 0; i < tabs.mainModule.tabBarViews.length; i++) {
            tabs.mainModule.tabBarViews[i].destroy();
          }
          tabs.mainModule.tabBarViews.splice(0);
        }

        if (state) {
          var right = state.workspace.paneContainers.right.paneContainer.root;
          for (var i = 0; i < right.items.length; i++) {
            if (right.items[i].deserializer == 'TreeView' || right.items[i].deserializer == 'GitDockItem') {
              right.items[i] = null;
            }
          }

          var left = state.workspace.paneContainers.left.paneContainer.root;
          for (var i = 0; i < left.items.length; i++) {
            if (left.items[i].deserializer == 'TreeView' || left.items[i].deserializer == 'GitDockItem') {
              left.items[i] = null;
            }
          }

          var center = state.workspace.paneContainers.center.root;
          for (var i = 0; i < center.items.length; i++) {
            if (center.items[i].deserializer == 'TreeView' || center.items[i].deserializer == 'GitDockItem') {
              center.items[i] = null;
            }
          }

          var bottom = state.workspace.paneContainers.bottom.paneContainer.root;
          for (var i = 0; i < bottom.items.length; i++) {
            if (bottom.items[i].deserializer == 'TreeView' || bottom.items[i].deserializer == 'GitDockItem') {
              bottom.items[i] = null;
            }
          }

          // Deserialize
          atomDeserialize(state);

          // Activate pane
          atom.workspace.getActivePane().activate();
        } else {
          // Set project paths
          atom.project.setPaths(paths);

          // Close all buffers
          closeAllBuffers();
        }

        // HACK[Pigments]: Pigments needs to reload on project reload
        var pigments = atom.packages.getActivePackage('pigments');
        if (pigments) {
          pigments.mainModule.reloadProjectVariables();
        }

        // Done
        resolve();
      })
    }, reject)
  });
}

// Close the current project (to bring the editor back to an empty state)
exports.close = function () {
  // Save the state of the current project
  saveCurrentState().then(() => {
    // Set project paths
    atom.project.setPaths([]);

    // Close all buffers
    closeAllBuffers();

    // TODO: Should we close the tree-view?
    var tv = getTreeView();
    if (tv) {
      if (tv.isVisible()) {
        tv.detach();
      }
    }
  });
}
