var util = Npm.require('util');
var EventEmitter = Npm.require('events').EventEmitter;

function Invalidator() {
  this._cursors = {};
  this._collections = {};
  this.UPDATE_OPERATIONS = generateUpdateOperationsMap();

  function generateUpdateOperationsMap() {
    var updateOnly = ['$inc', '$setOnInsert', '$set', '$addToSet', '$pop', '$pullAll', '$pull', '$pushAll', '$push', '$bit'];
    var removeOnly = ['$unset'];
    var updateAndRemove = ['$rename'];

    var map = {};
    updateOnly.forEach(function(field) {
      map[field] = 'UPDATE_ONLY';
    });

    removeOnly.forEach(function(field) {
      map[field] = 'REMOVE_ONLY';
    });

    updateAndRemove.forEach(function(field) {
      map[field] = 'UPDATE_AND_REMOVE';
    });

    return map;
  };
}

util.inherits(Invalidator, EventEmitter);

Invalidator.prototype.updateModifierToFields = function updateModifierToFields(modifier) {
  var result = {update: {}, remove: {}};
  for(var operation in modifier) {
    var action = this.UPDATE_OPERATIONS[operation];
    pickFields(modifier[operation], action);
  }

  function pickFields(updateCommand, action) {
    if(action == 'UPDATE_ONLY') {
      for(var key in updateCommand) {
        result.update[handleDot(key)] = 1;
      }
    } else if(action == 'REMOVE_ONLY') {
      for(var key in updateCommand) {
        result.remove[handleDot(key)] = 1;
      }
    } else if(action == 'UPDATE_AND_REMOVE') {
      for(var key in updateCommand) {
        result.update[handleDot(key)] = 1;
        result.remove[handleDot(key)] = 1;
      }
    }
  }

  function handleDot(key) {
    var dotIndex = key.indexOf('.');
    if(dotIndex >= 0) {
      return key.substring(0, dotIndex);
    } else {
      return key;
    }
  }

  return result;
};

Invalidator.prototype.registerCollection = function(name, collection) {
  this._collections[name] = collection;
};

Invalidator.prototype.addCursor = function addCursor(collectionName, cursor) {
  if(!this._cursors[collectionName]) {
    this._cursors[collectionName] = [];
  }
  var index = this._cursors[collectionName].indexOf(cursor);
  if(index < 0) {
    this._cursors[collectionName].push(cursor);
  }
};

Invalidator.prototype.removeCursor = function removeCursor(collectionName, cursor) {
  var index = this._cursors[collectionName].indexOf(cursor);
  if(index >= 0) {
    this._cursors[collectionName].splice(index, 1);
  }
};

// expect doc to have _id
Invalidator.prototype.invalidateInsert = function(collectionName, doc) {
  if(this._cursors[collectionName]) {
    this._cursors[collectionName].forEach(function(cursor) {
      if(cursor._selectorMatcher(doc)) {
        cursor._added(doc);
      }
    });
  }
};

Invalidator.prototype.invalidateRemove = function(collectionName, id) {
  if(this._cursors[collectionName]) {
    this._cursors[collectionName].forEach(function(cursor) {
      if(cursor._idExists(id)) {
        cursor._removed(id);
      }
    });
  }
};

Invalidator.prototype.invalidateUpdate = function(collectionName, id, modifier) {
  var self = this;
  var collection = this._collections[collectionName];
  var fields;
  var version;

  if(collection) {
    var fieldLists = this.updateModifierToFields(modifier);
    fields = _.extend(fieldLists.update, fieldLists.remove);
    version = collection.versionManager.begin(id, fields);
    collection._collection.findOne({_id: id}, afterFound);
  } else {
    logger.warn('asked to invalidateUpdate non-existing collection: ' + collectionName);
  }

  function afterFound(err, doc) {
    if(err) {
      collection.versionManager.abort(id, version);
    } else if(doc) {
      //invalidate cursors for added if this update affect them
      notifyAdded(doc);

      //invalidate cursors for removed if this affect them
      notifyRemoved(doc);

      //invalidate cursors for update
      var filteredFields = _.pick(doc, Object.getOwnPropertyNames(fields));
      var versionedResult = collection.versionManager.commit(id, version, filteredFields);
      notifyChanges(versionedResult);
    } else {
      collection.versionManager.abort(id, version);
    }
  }

  function notifyAdded(doc) {
    if(self._cursors[collectionName]) {
      self._cursors[collectionName].forEach(function(cursor) {
        if(!cursor._idExists(id) && cursor._selectorMatcher(doc)) {
          cursor._added(doc);
        }
      });
    }
  }

  function notifyRemoved(doc) {
    if(self._cursors[collectionName]) {
      self._cursors[collectionName].forEach(function(cursor) {
        if(cursor._idExists(id) && !cursor._selectorMatcher(doc)) {
          cursor._removed(id);
        }
      });
    }
  }
  
  function notifyChanges(fields) {
    if(self._cursors[collectionName]) {
      self._cursors[collectionName].forEach(function(cursor) {
        if(cursor._idExists(id)) {
          cursor._changed(id, fields);
        }
      });
    }
  }

};

Meteor.SmartInvalidator = new Invalidator();