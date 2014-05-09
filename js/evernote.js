var Evernote = new function() {
    var self = this,
        EVERNOTE_SERVER = "https://www.evernote.com",
        OAUTH_CONSUMER_KEY = "yor4",
        OAUTH_CONSUMER_SECRET = "e5286e971e058b8d",
        OAUTH_TOKEN_SECRET = "",
        NOTESTORE_HOST = EVERNOTE_SERVER,
        NOTESTORE_PORT = "443",
        NOTESTORE_PROTOCOL = "https",
        OAUTH_SIGNATURE_METHOD = "PLAINTEXT",
        NOTES_APP_CALLBACK_URL = "http://ffos-notes.local/redirect.html",
        REQUEST_TOKEN_URL = EVERNOTE_SERVER+"/oauth",
        ACCESS_TOKEN_URL = EVERNOTE_SERVER+"/oauth",
        AUTHORIZATION_URL = EVERNOTE_SERVER+"/OAuth.action",
        EVERNOTE_SET_TOKEN_URL = EVERNOTE_SERVER+"/SetAuthToken.action",
        EVERNOTE_PREMIUM_ACTION = "/Checkout.action?origin=api-platform&offer="+OAUTH_CONSUMER_KEY,

        TEXTS = null,

        NAME_CONFLICT_POSTFIX = " - 1",
        MAX_RESOURCE_SIZE_TO_FETCH = 1*1024*1024,
        
        tmp_oauth_token,
        oauth_verifier,
        oauth_token,
        note_store_url,
        shard_url,
        expires,
        last_update_count,
        last_sync_time,
        sync_try_count,
        
        syncChunks = [],
        totalSyncChunks = 0,
        syncMaxEntries = 100,
        syncMaxTries = 1,
        firstUSN = 0,
        currentUSN = 0,
        lastChunkUSN = 0,
        lastUSN = 0,
        
        migratedCount = 0,
        totalToMigrate = 0,
        
        queueList = {
            notebooks : [],
            notes : []
        },
        totalQueueChunks = 0,

        syncList = {
            notebooks : [],
            notes : [],
            expungedNotebooks : [],
            expungedNotes : []
        },

        noteStoreTransport,
        noteStoreProtocol,
        noteStore;

    this.init = function(user) {
        self.setupTexts();


        oauth_token = user.getOauthToken();
        note_store_url = user.getNoteStoreUrl();
        shard_url = user.getShardUrl();
        expires = user.getExpires();
        last_update_count = user.getLastUpdateCount();
        last_sync_time = user.getLastSyncTime();
        sync_try_count = user.getSyncTryCount();
        
        if (App.DEBUG) {
            Console.log('Evernote.init()');
            Console.log('oauth_token: '+oauth_token);
            Console.log('note_store_url: '+note_store_url);
            Console.log('shard_url: '+shard_url);
            Console.log('expires: '+expires);
            Console.log('last_update_count: '+last_update_count);
            Console.log('last_sync_time: '+last_sync_time);
        }

        initNoteStore();

        if (last_sync_time == 0) {
            self.startFullSync();
        } else {
            self.getSyncState();
        }

        document.addEventListener('localechange', function(){
            navigator.mozL10n.ready(function(){
                self.setupTexts();
            });
        }, false);
    };

    this.processXHR = function(url, method, callback) {
        var xhr = new XMLHttpRequest({mozSystem: true});
        xhr.open(method, url, true);
        if (App.DEBUG) {
            Console.log('processXHR url: '+url);
        }
        xhr.onreadystatechange = function() {

            if (xhr.readyState === 4) {
                if (App.DEBUG) {
                    Console.log('processXHR xhr: '+JSON.stringify(xhr));
                    Console.log('processXHR xhr.responseText: '+xhr.responseText);
                }
                // check to see if there was an error returned from Evernote server
                if (xhr.responseText.match('<title>.*(Error)')) {
                    if (!TEXTS) {
                        self.setupTexts();
                    }
                    alert(TEXTS.NOT_REACHED_EVERNOTE);
                    App.stopSync();
                    return;
                }
                if (typeof callback == 'function') {
                    callback(xhr);
                }
            }
        };

        xhr.send();
    };

    this.buildOauthURL = function(url, method, parameters) {
        var accessor = {
            token: null,
            tokenSecret: null,
            consumerKey: OAUTH_CONSUMER_KEY,
            consumerSecret: OAUTH_CONSUMER_SECRET
        };

        var message = {
            action: url,
            method: method,
            parameters: parameters
        };

        OAuth.completeRequest(message, accessor);
        OAuth.SignatureMethod.sign(message, accessor);

        return url + '?' + OAuth.formEncode(message.parameters);
    };

    this.login = function() {
        var postUrl = self.buildOauthURL(REQUEST_TOKEN_URL, 'POST', {
            oauth_callback : NOTES_APP_CALLBACK_URL,
            oauth_signature_method : OAUTH_SIGNATURE_METHOD
        });
        self.processXHR(postUrl, 'POST', function(xhr){
            if (xhr.responseText) {
                var responseData = {};
                var response = xhr.responseText.split('&');
                for (var i in response) {
                    var data = response[i].split('=');
                    responseData[data[0]] = data[1];
                }
                tmp_oauth_token = responseData['oauth_token'];

                self.getAuthorization();
            } else {
                if (!TEXTS) {
                    self.setupTexts();
                }
                alert(TEXTS.NOT_REACHED_EVERNOTE);
            }
        });
    };

    this.logout = function() {
        DB.destroy(function(){
            window.location.href = "?signedout";
        });
    };

    this.premium = function() {
        var premiumUrl = EVERNOTE_SET_TOKEN_URL + "?auth=" + encodeURIComponent(oauth_token) + "&targetUrl=" + encodeURIComponent(EVERNOTE_PREMIUM_ACTION);
        if (App.DEBUG) {
            Console.log('this.premium url: ' + JSON.stringify(premiumUrl));
        }
        window.open(premiumUrl);
    };

    this.getAuthorization = function() {
        if (App.DEBUG) {
            Console.log('getAuthorization url: '+AUTHORIZATION_URL+'?oauth_token='+tmp_oauth_token);
        }
        var authWindow = window.open(AUTHORIZATION_URL+'?oauth_token='+tmp_oauth_token);
        window.addEventListener('message', function onMessage(evt) {
            if (authWindow == evt.source &&
                evt.origin === window.location.origin) {
                authWindow.close();
                tmp_oauth_token = evt.data.oauth_token;
                oauth_verifier = evt.data.oauth_verifier;
                
                self.getAccessToken();
            }
        });
    };

    this.getAccessToken = function() {
        var postUrl = self.buildOauthURL(REQUEST_TOKEN_URL, 'POST', {
            oauth_token : tmp_oauth_token,
            oauth_verifier : oauth_verifier,
            oauth_signature_method : OAUTH_SIGNATURE_METHOD
        });
        self.processXHR(postUrl, 'POST', function(xhr){
            var responseData = {};
            var response = xhr.responseText.split('&');
            for (var i in response) {
                var data = response[i].split('=');
                responseData[data[0]] = data[1];
            }
            oauth_token = decodeURIComponent(responseData['oauth_token']);
            note_store_url = decodeURIComponent(responseData['edam_noteStoreUrl']);
            shard_url = decodeURIComponent(responseData['edam_webApiUrlPrefix']);
            expires = responseData['edam_expires'];

            self.finishAuthenticationProcess();
        });
    };

    this.finishAuthenticationProcess = function() {
        var userStoreTransport = new Thrift.BinaryHttpTransport(EVERNOTE_SERVER + '/edam/user');
        var userStoreProtocol = new Thrift.BinaryProtocol(userStoreTransport, false, false);
        var userStore = new UserStoreClient(userStoreProtocol, userStoreProtocol);

        initNoteStore();

        last_update_count = App.getUser().getLastUpdateCount();
        last_sync_time = App.getUser().getLastSyncTime();
        sync_try_count = App.getUser().getSyncTryCount();
        
        var callback = self.getSyncState;
        if (last_sync_time == 0) {
            callback = self.startFullSync;
        }

        userStore.getUser(oauth_token, function(user){
            delete user.id;
            user.oauth_token = oauth_token;
            user.note_store_url = note_store_url;
            user.shard_url = shard_url;
            user.expires = expires;
            user.last_update_count = last_update_count;
            user.last_sync_time = last_sync_time;
            user.sync_try_count = sync_try_count;
            
            App.onLogin();

            App.updateUserData(user, callback);
        }, self.onError);
    };

    this.getSyncState = function() {
        if (App.DEBUG) {
            Console.log('this.getSyncState oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.getSyncState(oauth_token, function(state) {
            if (App.DEBUG) {
                Console.log('getSyncState: '+JSON.stringify(state));
                Console.log('state.fullSyncBefore: '+state.fullSyncBefore);
                Console.log('last_sync_time: '+last_sync_time);
                Console.log('state.updateCount: '+state.updateCount);
                Console.log('last_update_count: '+last_update_count);
            }
            if (state.fullSyncBefore > last_sync_time) {
                self.startFullSync();
            } else if(state.updateCount == last_update_count) {
                self.sendChanges();
            } else {
                self.startIncrementalSync();
            }
        }, self.onError);
    };

    this.startIncrementalSync = function() {
        firstUSN = 0;
        self.getSyncChunk(last_update_count, syncMaxEntries, false, self.processSyncChunk);
    };
    this.startFullSync = function() {
        App.startSync();
        self.migrateAllData(function() {
            firstUSN = 0;
            self.getSyncChunk(0, syncMaxEntries, true, self.processSyncChunk);
        });
    };

    this.getSyncChunk = function(usn, max, full, c) {
        if (sync_try_count >= syncMaxTries) {
            if (!TEXTS) {
                self.setupTexts();
            }
            if (!confirm(TEXTS.SYNC_FAILED)) {
                self.logout();
                return;
            }
        }
        if (!navigator.onLine) {
            if (!TEXTS) {
                self.setupTexts();
            }
            alert(TEXTS.NOT_REACHED_EVERNOTE);
            return;
        }
        App.updateUserData({
            sync_try_count : sync_try_count + 1
        });

        App.startSync();
        if (App.DEBUG) {
            Console.log('this.getSyncChunk oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.getSyncChunk(oauth_token, usn, max, full, c, self.onError);
    };

    this.processSyncChunk = function(chunk) {
        lastChunkUSN = chunk.chunkHighUSN;
        lastUSN = chunk.updateCount;
        if (firstUSN === 0) {
            firstUSN = lastUSN;
            currentUSN = 0;
        }
        
        if (chunk.notebooks && chunk.notebooks.length > 0) {
            for (var j in chunk.notebooks) {
                syncList.notebooks.push(chunk.notebooks[j]);
                if (firstUSN > chunk.notebooks[j].updateSequenceNum) {
                    firstUSN = chunk.notebooks[j].updateSequenceNum;
                }
            }
        }
        if (chunk.notes && chunk.notes.length > 0) {
            for (var j in chunk.notes) {
                syncList.notes.push(chunk.notes[j]);
                if (firstUSN > chunk.notes[j].updateSequenceNum) {
                    firstUSN = chunk.notes[j].updateSequenceNum;
                }
            }
        }
        if (chunk.expungedNotebooks && chunk.expungedNotebooks.length > 0) {
            for (var j in chunk.expungedNotebooks) {
                syncList.expungedNotebooks.push(chunk.expungedNotebooks[j]);
                if (firstUSN > chunk.expungedNotebooks[j].updateSequenceNum) {
                    firstUSN = chunk.expungedNotebooks[j].updateSequenceNum;
                }
            }
        }
        if (chunk.expungedNotes && chunk.expungedNotes.length > 0) {
            for (var j in chunk.expungedNotes) {
                syncList.expungedNotes.push(chunk.expungedNotes[j]);
                if (firstUSN > chunk.expungedNotes[j].updateSequenceNum) {
                    firstUSN = chunk.expungedNotes[j].updateSequenceNum;
                }
            }
        }
        last_update_count = chunk.updateCount;
        last_sync_time = chunk.currentTime;

        if (currentUSN == 0) {
            currentUSN = firstUSN;
        }
        self.processSyncChunkList();
    };
    
    this.processSyncChunkList = function() {
        var chunk = null;
        var percentage = 100;
        if (firstUSN < lastUSN) {
            percentage = ((currentUSN - firstUSN) * 100) / (lastUSN - firstUSN);
        }
        self.updateProgressBar(percentage);
        if (App.DEBUG) {
            Console.log('this.processSyncList');
            Console.log('this.processSyncList syncList.notebooks.length: '+syncList.notebooks.length);
            Console.log('this.processSyncList syncList.notes.length: '+syncList.notes.length);
            Console.log('this.processSyncList syncList.expungedNotebooks.length: '+syncList.expungedNotebooks.length);
            Console.log('this.processSyncList syncList.expungedNotes.length: '+syncList.expungedNotes.length);
        }
        if (syncList.notebooks.length > 0) {
            chunk = syncList.notebooks.shift();
            self.processNotebookChunk(chunk);
        } else if (syncList.notes.length > 0) {
            chunk = syncList.notes.shift();
            currentUSN = chunk.updateSequenceNum;
            self.processNoteChunk(chunk);
        } else if (syncList.expungedNotebooks.length > 0) {
            chunk = syncList.expungedNotebooks.shift();
            self.processExpungedNotebookChunk(chunk);
        } else if (syncList.expungedNotes.length > 0) {
            chunk = syncList.expungedNotes.shift();
            self.processExpungedNoteChunk(chunk);
        } else {
            if (lastChunkUSN < lastUSN) {
                noteStore.getSyncChunk(oauth_token, lastChunkUSN, syncMaxEntries, true, self.processSyncChunk, self.onError);
            } else {
                self.finishSync();
            }
        }
    };

    this.updateProgressBar = function(percentage) {
        document.querySelector('progress').value = parseInt(Math.ceil(percentage));
    }
    this.processNotebookChunk = function(chunk) {
        if (App.DEBUG) {
            Console.log('this.processNotebookChunk (chunk): '+JSON.stringify(chunk));
        }
        var notebook = chunk;
        if (App.DEBUG) {
            Console.log('self.getNotebook: '+JSON.stringify(notebook));
        }
        DB.getNotebookByIndex("guid", notebook.guid, function(resultsGuid){
            if (App.DEBUG) {
                Console.log('DB.getNotebookByIndex by guid: '+JSON.stringify(resultsGuid));
            }
            DB.getNotebookByIndex("name", notebook.name, function(resultsName){
                if (App.DEBUG) {
                    Console.log('DB.getNotebookByIndex by name: '+JSON.stringify(resultsName));
                }
                DB.getQueues({rel: "Notebook", rel_guid: notebook.guid}, function(resultsQueue){
                    if (App.DEBUG) {
                        Console.log('DB.getQueues by notebook.guid: '+JSON.stringify(resultsQueue));
                    }
                    if (resultsQueue.length == 0) {
                        if (resultsGuid == null) {
                            if (resultsName == null) {
                                App.getUser().newNotebook(notebook, self.processSyncChunkList);
                            } else {
                                if (!resultsName.getGuid() || resultsName.getGuid() == notebook.guid) {
                                    resultsName.set(notebook, self.processSyncChunkList);
                                } else {
                                    App.getUser().newNotebook(notebook, self.processSyncChunkList);
                                }
                            }
                        } else {
                            resultsGuid.set(notebook, self.processSyncChunkList);
                        }
                    } else {
                        if (resultsQueue[0].getExpunge()) {
                            if (!TEXTS) {
                                self.setupTexts();
                            }
                            if (confirm(TEXTS.NOTEBOOK_DELETE_CONFLICT)) {
                                App.getUser().newNotebook(notebook, function(){
                                    resultsQueue[0].remove(self.processSyncChunkList);
                                });
                            } else {
                                self.processSyncChunkList();
                            }
                        } else {
                            if (resultsGuid.getName() != notebook.name) {
                                if (!TEXTS) {
                                    self.setupTexts();
                                }
                                var txt = TEXTS.GENERIC_CONFLICT.replace("{{date}}", new Date(notebook.serviceUpdated));
                                    txt = txt.replace("{{object}}", "Notebook");
                                    txt = txt.replace("{{name}}", '"'+resultsGuid.getName()+'"');
                                if (!confirm(txt)) {
                                    resultsGuid.set(notebook, function(){
                                        resultsQueue[0].remove(self.processSyncChunkList);
                                    });
                                } else {
                                    self.processSyncChunkList();
                                }
                            } else {
                                resultsGuid.set(notebook, self.processSyncChunkList);
                            }
                        }
                    }
                });
            });
        });
    };
    this.processNoteChunk = function(chunk) {
        if (App.DEBUG) {
            Console.log('this.processNoteChunk (chunk): '+JSON.stringify(chunk));
        }
        var note = chunk;
        if (App.DEBUG) {
            Console.log('self.getNote: '+JSON.stringify(note));
        }
        DB.getNoteByIndex("guid", note.guid, function(resultsNote){
            Console.log('DB.getNoteByIndex: done for '+note.guid);
            if (App.DEBUG) {
                Console.log('DB.getNoteByIndex: '+JSON.stringify(resultsNote));
            }
            DB.getQueues({rel: "Note", rel_guid: note.guid}, function(resultsQueue){
                Console.log('DB.getQueues: done for '+note.guid);
                if (App.DEBUG) {
                    Console.log('DB.getQueues by note.guid: '+JSON.stringify(resultsQueue));
                }
                if (resultsQueue.length > 0) {
                    if (!TEXTS) {
                        self.setupTexts();
                    }
                    var txt = TEXTS.GENERIC_CONFLICT.replace("{{date}}", new Date(note.updated));
                        txt = txt.replace("{{object}}", "Note");
                        txt = txt.replace("{{name}}", '"'+resultsNote.getTitle()+'"');
                    if (!confirm(txt)) {
                        resultsNote.set(note, function(newNote){
                            if (resultsNote.isTrashed() && newNote.isActive()) {
                                newNote.restore(self.processSyncChunkList);
                            } else if (!resultsNote.isTrashed() && !newNote.isActive()) {
                                newNote.trash(self.processSyncChunkList);
                            } else {
                                self.processSyncChunkList();
                            }
                        });
                    } else {
                        self.processSyncChunkList();
                    }
                } else {
                    if (resultsNote) {
                        resultsNote.set(note, function(newNote){
                            if (resultsNote.isTrashed() && newNote.isActive()) {
                                newNote.restore(self.processSyncChunkList);
                            } else if (!resultsNote.isTrashed() && !newNote.isActive()) {
                                newNote.trash(self.processSyncChunkList);
                            } else {
                                self.processSyncChunkList();
                            }
                        });
                    } else {
                        DB.getNotebookByIndex("guid", note.notebookGuid, function(notebook){
                            if (App.DEBUG) {
                                Console.log('DB.getNotebookByIndex: '+JSON.stringify(notebook));
                            }
                            if (notebook) {
                                notebook.newNote(note, function(newNote){
                                    if (!newNote.isActive()) {
                                        newNote.trash();
                                    }
                                    self.processSyncChunkList();
                                });
                            } else {
                                self.processSyncChunkList();
                            }
                        });
                    }
                }
            });
        });
    };
    this.processExpungedNotebookChunk = function(chunk) {
        if (App.DEBUG) {
            Console.log('this.processExpungedNotebookChunk (chunk): '+JSON.stringify(chunk));
        }
        DB.getNotebookByIndex("guid", chunk, function(notebook){
            if (notebook) {
                notebook.remove();
            }
            self.processSyncChunkList();
        });
    };
    this.processExpungedNoteChunk = function(chunk) {
        if (App.DEBUG) {
            Console.log('this.processExpungedNoteChunk (chunk): '+JSON.stringify(chunk));
        }
        DB.getNoteByIndex("guid", chunk, function(note){
            if (note) {
                note.remove();
            }
            self.processSyncChunkList();
        });
    };
    this.finishSync = function() {
        App.stopSync();
        App.updateUserData({
            last_update_count : last_update_count,
            last_sync_time : last_sync_time,
            sync_try_count : 0
        }, self.sendChanges);
    };
    this.noteContentLoaded = function(note) {
        App.updateNoteContent(note);
    };
    this.resourceLoaded = function(resource) {
        App.resourceDataLoaded(resource);
    };

    this.sendChanges = function() {
        App.getQueues(function(queues){
            if (App.DEBUG) {
                Console.log('this.sendChanges: '+JSON.stringify(queues));
            }
            if (queues.length > 0) {
                queueList = {
                    notebooks : [],
                    notes : []
                };
                for(var i in queues) {
                    if (queues[i].getRel() == 'Notebook') {
                        queueList.notebooks.push(queues[i]);
                        totalQueueChunks++;
                    } else if (queues[i].getRel() == 'Note') {
                        queueList.notes.push(queues[i]);
                        totalQueueChunks++;
                    }
                }
	            self.processQueueList();
            }
        });
    };

    this.processQueueList = function() {
        App.startSync();
        var queue = null;
        var remainingSyncChunks = queueList.notebooks.length
                                + queueList.notes.length;
        var percentage = 100;
 		if (totalQueueChunks > 0) {
			percentage = ((totalQueueChunks - remainingSyncChunks) * 100) / totalQueueChunks;
		}
        self.updateProgressBar(percentage);
        if (App.DEBUG) {
            Console.log('this.processQueueList');
            Console.log('this.processQueueList queueList.notebooks.length: '+queueList.notebooks.length);
            Console.log('this.processQueueList queueList.notes.length: '+queueList.notes.length);
        }
        if (queueList.notebooks.length > 0) {
            queue = queueList.notebooks.pop();
            if (App.DEBUG) {
                Console.log('this.processQueueList notebook queue: '+JSON.stringify(queue));
            }
            self.processNotebookQueue(queue);
        } else if (queueList.notes.length > 0) {
            queue = queueList.notes.pop();
            if (App.DEBUG) {
                Console.log('this.processQueueList note queue: '+JSON.stringify(queue));
            }
            self.processNoteQueue(queue);
        } else {
            self.finishProcessQueueList();
        }
    };
    this.processNotebookQueue = function(queue) {
        if (App.DEBUG) {
            Console.log('this.processNotebookQueue queue: '+JSON.stringify(queue));
        }
        if (queue.getExpunge()) {
            self.deleteNotebook(queue.getRelGuid(), function(){
                queue.remove(self.processQueueList);
            });
        } else {
            DB.getNotebooks({id : queue.getRelId()}, function(notebook){
                if (notebook.length > 0) {
                    notebook = notebook[0];

                    if (App.DEBUG) {
                        Console.log('this.processNotebookQueue notebook: '+JSON.stringify(notebook));
                        Console.log('this.processNotebookQueue notebook.getGuid(): '+notebook.getGuid());
                        Console.log('this.processNotebookQueue notebook.isTrashed(): '+notebook.isTrashed());
                    }
                    if (notebook.getGuid()) {
                        self.updateNotebook(notebook, function() {
                            queue.remove(self.processQueueList);
                        });
                    } else {
                        self.newNotebook(notebook, function() {
                            queue.remove(self.processQueueList);
                        });
                    }
                }
            });
        }
    };
    this.processNoteQueue = function(queue) {
        if (App.DEBUG) {
            Console.log('this.processNoteQueue queue: '+JSON.stringify(queue));
        }
        if (queue.getExpunge()) {
            self.expungeNote(queue.getRelGuid(), function(){
                queue.remove(self.processQueueList);
            })
        } else {
            DB.getNotes({id : queue.getRelId()}, function(note){
                if (note.length > 0) {
                    note = note[0];

                    if (App.DEBUG) {
                        Console.log('this.processNoteQueue note: '+JSON.stringify(note));
                        Console.log('this.processNoteQueue note.getGuid(): '+note.getGuid());
                        Console.log('this.processNoteQueue note.isTrashed(): '+note.isTrashed());
                    }
                    if (note.getGuid()) {
                        if (note.isTrashed()) {
                            self.deleteNote(note.getGuid(), function(){
                                queue.remove(self.processQueueList);
                            });
                        } else {
                            self.updateNote(note, function(newNote) {
                                queue.remove(self.processQueueList);
                            });
                        }
                    } else {
                        self.newNote(note, function(newNote) {
                            if (note.isTrashed()) {
                                self.deleteNote(newNote.getGuid());
                            }
                            queue.remove(self.processQueueList);
                        });
                    }
				} else {
					// Note not in DB - skip it
					queue.remove(self.processQueueList);
                }
            });
        }
    };

    this.finishProcessQueueList = function() {
        if (App.DEBUG) {
            Console.log('this.finishProcessQueueList');
        }
        App.stopSync();
        App.refershNotebooksList();
        App.refershNotebookView();
    };

    this.newNotebook = function(notebook, cbSuccess, cbError) {
        if (App.DEBUG) {
            Console.log('this.newNotebook');
        }
        var notebookData = notebook.export();
        notebookData.name = notebookData.name.replace(/(^[\s]+|[\s]+$)/g, '');
        if (App.DEBUG) {
            Console.log('this.newNotebook oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.createNotebook(oauth_token, new Notebook(notebook.export()), function(remoteNotebook) {
            notebook.set(remoteNotebook, cbSuccess);
            if (App.getUser().getLastUpdateCount() < remoteNotebook.updateSequenceNum) {
                App.updateUserData({
                    last_update_count : remoteNotebook.updateSequenceNum
                });
            }
        }, function(error){
            if (App.DEBUG) {
                Console.log('noteStore.newNotebook error: '+ JSON.stringify(error));
            }
            if (error.parameter == "Notebook.name") {
                notebook.set({
                    name: notebook.getName() + NAME_CONFLICT_POSTFIX
                }, function(notebook){
                    self.newNotebook(notebook, cbSuccess);
                });
            }
        });
    };
    this.updateNotebook = function(notebook, cbSuccess, cbError) {
        if (App.DEBUG) {
            Console.log('this.updateNotebook');
        }
        var notebookData = notebook.export();
        notebookData.name = notebookData.name.replace(/(^[\s]+|[\s]+$)/g, '');
        notebookData.restrictions = new NotebookRestrictions(notebookData.restrictions);
        if (App.DEBUG) {
            Console.log('this.updateNotebook oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.updateNotebook(oauth_token, new Notebook(notebookData), function(remoteNotebook) {
            notebook.set(remoteNotebook, cbSuccess);
            if (App.getUser().getLastUpdateCount() < remoteNotebook.updateSequenceNum) {
                App.updateUserData({
                    last_update_count : remoteNotebook.updateSequenceNum
                });
            }
        }, function(error) {
            if (App.DEBUG) {
                Console.log('noteStore.updateNotebook error: ' + JSON.stringify(error));
            }
            if (cbError) {
                cbError();
            } else {
                cbSuccess();
            }
        });
    };
    this.deleteNotebook = function(notebookGuid, cbSuccess, cbError) {
        if (App.DEBUG) {
            Console.log('this.deleteNotebook: ' + JSON.stringify(notebookGuid));
            Console.log('this.deleteNotebook oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.expungeNotebook(oauth_token, notebookGuid, cbSuccess, function(error) {
            if (App.DEBUG) {
                Console.log('noteStore.expungeNotebook error: ' + JSON.stringify(error));
            }
            if (cbError) {
                cbError();
            } else {
                cbSuccess();
            }
        });
    };

    this.newNote = function(note, cbSuccess, cbError) {
        if (App.DEBUG) {
            Console.log('this.newNote: '+JSON.stringify(note));
        }
        DB.getNotebooks({"id": note.getNotebookId()}, function(notebook) {
            if (notebook.length > 0) {
                notebook = notebook[0];
                note = note.set({notebookGuid : notebook.getGuid()});
                var noteData = note.export();
                if (noteData.resources) {
                    for(var k in noteData.resources) {
                        noteData.resources[k] = self.buildResourceObject(noteData.resources[k]);
                    }
                }
                noteData.title = noteData.title.replace(/(^[\s]+|[\s]+$)/g, '');
                if (App.DEBUG) {
                    Console.log('this.newNote oauth_token: ' + JSON.stringify(oauth_token));
                }
                noteStore.createNote(oauth_token, new Note(noteData), function(remoteNote) {
                    if (App.DEBUG) {
                        Console.log('this.newNote (noteStore.createNote): '+JSON.stringify(remoteNote));
                    }
                    self.getNote(remoteNote.guid, function(remoteNote) {
                        if (App.DEBUG) {
                            Console.log('this.newNote (self.getNote): '+JSON.stringify(remoteNote));
                        }
                        udatedNote = note.set(remoteNote);
                        if (App.getUser().getLastUpdateCount() < remoteNote.updateSequenceNum) {
                            App.updateUserData({
                                last_update_count : remoteNote.updateSequenceNum
                            });
                        }
                        cbSuccess(udatedNote);
                    }, cbError || cbSuccess);
                }, function(error) {
                    if (App.DEBUG) {
                        Console.log('noteStore.newNote error: ' + JSON.stringify(error));
                    }
                    if (cbError) {
                        cbError();
                    } else {
                        cbSuccess();
                    }
                });
            } else {
                cbSuccess();
            }
        }, cbError || cbSuccess);
    };
    this.updateNote = function(note, cbSuccess, cbError) {
        if (App.DEBUG) {
            Console.log('this.updateNote: '+JSON.stringify(note));
            Console.log('this.updateNote oauth_token: ' + JSON.stringify(oauth_token));
        }
        var noteData = note.export();
        if (noteData.resources) {
            for(var k in noteData.resources) {
                noteData.resources[k] = self.buildResourceObject(noteData.resources[k]);
            }
        }
        noteStore.updateNote(oauth_token, new Note({
            guid: noteData.guid,
            title: noteData.title,
            content: noteData.content,
            resources: noteData.resources
        }), function(remoteNote) {
            self.getNote(remoteNote.guid, function(remoteNote) {
                udatedNote = note.set(remoteNote);
                if (App.getUser().getLastUpdateCount() < remoteNote.updateSequenceNum) {
                    App.updateUserData({
                        last_update_count : remoteNote.updateSequenceNum
                    });
                }
                cbSuccess(udatedNote);
            }, cbError || cbSuccess);
        }, function(error) {
            if (App.DEBUG) {
                Console.log('noteStore.updateNote error: ' + JSON.stringify(error));
            }
            if (cbError) {
                cbError();
            } else {
                cbSuccess();
            }
        });
    };
    this.deleteNote = function(guid, cbSuccess, cbError) {
        if (App.DEBUG) {
            Console.log('this.deleteNote: ' + JSON.stringify(guid));
            Console.log('this.deleteNote oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.deleteNote(oauth_token, guid, cbSuccess, function(error) {
            if (App.DEBUG) {
                Console.log('noteStore.deleteNote error: ' + JSON.stringify(error));
            }
            if (cbError) {
                cbError();
            } else {
                cbSuccess();
            }
        });
    };
    this.expungeNote = function(guid, cbSuccess, cbError) {
        if (App.DEBUG) {
            Console.log('this.expungeNote: ' + JSON.stringify(guid));
            Console.log('this.expungeNote oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.expungeNote(oauth_token, guid, cbSuccess, function(error) {
            if (App.DEBUG) {
                Console.log('noteStore.expungeNote error: ' + JSON.stringify(error));
            }
            if (cbError) {
                cbError();
            } else {
                cbSuccess();
            }
        });
    };
    this.getNote = function(guid, cbSuccess, cbError) {
        cbError = cbError || self.onError;
        if (App.DEBUG) {
            Console.log('this.getNote guid: ' + JSON.stringify(guid));
            Console.log('this.getNote oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.getNote(oauth_token, guid, true, false, false, false, cbSuccess, cbError);
    };
    this.getNotebook = function(guid, cbSuccess, cbError) {
        cbError = cbError || self.onError;
        if (App.DEBUG) {
            Console.log('this.getNotebook guid: ' + JSON.stringify(guid));
            Console.log('this.getNotebook oauth_token: ' + JSON.stringify(oauth_token));
        }
        noteStore.getNotebook(oauth_token, guid, cbSuccess, cbError);
    };

    this.buildResourceObject = function(resource) {
        var rawMD5str = md5(resource.data.body, false, true),
            bodyHashArrayBuffer = new ArrayBuffer(rawMD5str.length*2); // 2 bytes for each char
        return new Resource({
            noteGuid : resource.noteGuid,
            mime : resource.mime,
            data : new Data({
                body : resource.data.body,
                bodyHash : bodyHashArrayBuffer,
                size : resource.data.size
            }),
            attributes : new ResourceAttributes({
                fileName : resource.attributes.fileName
            })
        });
    };

    this.enml2html = function(note, loadResources) {
        if (typeof note.data_text !== "undefined" && note.data_text != null && loadResources) {
            this.migrateNoteData(note, this.noteContentLoaded);
            return null;
        }
        if (note.data_content == null && loadResources) {
            // Delay fetching of note contents
            noteStore.getNote(oauth_token, note.getGuid(), true, false, false, false, this.noteContentLoaded);
            return null;
        }

        var hashMap = {};
        var noteResources = note.data_resources || [];
        for (var r in noteResources) {
            if (loadResources && noteResources[r].data.body == null) {
                // Delay fetching of resources
                // Fetch only if resource size is less than limit
                if ((noteResources[r].data.size <= MAX_RESOURCE_SIZE_TO_FETCH) &&
                    (noteResources[r].mime.match('image'))) {
                    noteStore.getResource(oauth_token, noteResources[r].guid, true, true, true, true, this.resourceLoaded);
                    App.pendingResourceData(noteResources[r].guid);
                } else {
                    App.noteResourceNotLoaded();
                }
            }
            if (noteResources[r].data.body instanceof ArrayBuffer && typeof noteResources[r].data.bodyHash === "string") {
                if (noteResources[r].data.body != null) {
                    hashMap[noteResources[r].data.bodyHash] = App.resizeImage(noteResources[r].data.body, noteResources[r].width, noteResources[r].height, noteResources[r].mime, noteResources[r].data.bodyHash);
                }
//                if (hashMap[noteResources[r].data.bodyHash] == null) {
//                    hashMap[noteResources[r].data.bodyHash] = window.URL.createObjectURL(ArrayBufferHelper.getBlob(null, noteResources[r].mime));
//                }
            } else {
                var key = "";

                for (var i in noteResources[r].data.bodyHash) {
                    key += String("0123456789abcdef".substr((noteResources[r].data.bodyHash[i] >> 4) & 0x0F,1)) + "0123456789abcdef".substr(noteResources[r].data.bodyHash[i] & 0x0F,1);
                }
                if (noteResources[r].data.body != null) {
                    hashMap[key] = App.resizeImage(noteResources[r].data.body, noteResources[r].width, noteResources[r].height, noteResources[r].mime, key);
                }
                if (noteResources[r].data.size > MAX_RESOURCE_SIZE_TO_FETCH) {
//                    hashMap[key] = "../images/image_missing.png";
                    hashMap[key] = null;
                }
//                if (hashMap[key] == null) {
//                    hashMap[key] = window.URL.createObjectURL(ArrayBufferHelper.getBlob(null, noteResources[r].mime));
//                }
            }
        }
        App.processImageResizeQueue();
        return enml.HTMLOfENML(note.getContent(false, false), hashMap);
    };

    this.html2enml = function(html) {
        html = '<html><head></head><body>'+html+'</body></html>';
        return new ENMLofHTML().parse(html).getOutput();
    };

    this.onError = function() {};

    this.setupTexts = function() {
        TEXTS = {
            "NOT_REACHED_EVERNOTE": navigator.mozL10n.get("not-reached-evernote"),
            "NOTEBOOK_DELETE_CONFLICT": navigator.mozL10n.get("notebook-delete-conflict"),
            "GENERIC_CONFLICT": navigator.mozL10n.get("generic-conflict"),
            "SYNC_FAILED": navigator.mozL10n.get("sync-failed")
        };
    };

    this.migrationComplete = function(callback) {
        App.updateMigrationStatus({
            migration_complete : true
        }, callback);
    };
    
    this.migrationInProgress = function() {
        return App.getUser().migration_complete != true;
    };
    
    this.migrateAllData = function(callback) {
        if (self.migrationInProgress()) {
            DB.getNotebooks({}, function(notebooks) {
                self.migrateNotebooks(notebooks, callback);
            });
        } else {
            callback && callback();
        }
    };
    
    this.migrateNotebooks = function(notebooks, callback) {
        if (notebooks.length > 0) {
            var notebook = notebooks.pop();
            App.addQueue("Notebook", notebook, function() {
               self.migrateNotebooks(notebooks, callback); 
            });
        } else {
            self.migrateAllNotes(callback);
        }
    };
    
    this.migrateAllNotes = function(callback) {
        if (self.migrationInProgress()) {
            DB.getNotes({"content":undefined}, function(notes) {
                totalToMigrate = notes.length;
                self.migrateNotes(notes, callback);
            });
        } else {
            callback && callback();
        }
    };
    
    this.migrateNotes = function(notes, callback) {
        if (notes.length > 0) {
            var n = notes.pop();
            migratedCount++;
            self.updateProgressBar((migratedCount*100)/totalToMigrate);
            self.migrateNoteData(n, function() {
                self.migrateNotes(notes, callback);
            });
        } else {
            self.migrationComplete(callback);
        }
    };
    
    this.migrateNoteData = function(note, callback) {
        // Get resource objects and
        // 1. convert to ArrayBuffer and compute hash
        // 2. create <img> element with hash only
        // 3. Replace images from obj.text with new <img>
        DB.getNoteResources({"noteId":note.data_id}, function(resources) {
            var content = note.data_text.replace("\n", "<br/>");
            var newResources = [];
            for (var i = 0, len = resources.length; i < len; i++) {
                var noteResource = self.createNoteResource(resources[i]);
                newResources.push(noteResource);
                content = content.concat(self.createImageTag(noteResource));
            }

            var newObj = {
                id: note.data_id,
                title: note.data_title || (content || "").split(/<br[^>]*>/i)[0],
                content: content,
                text: null,
                resources: newResources,
                country: note.data_country,
                city: note.data_city,
                date_created: note.data_date_created,
                date_updated: note.data_date_updated,
                trashed: note.data_trashed,
                active: true,
                notebook_id: note.data_notebook_id,
                metadata: note.data_metadata
            };

            note.set(newObj, function(note) {
                App.addQueue("Note", note, function() {
                    callback && callback(note);                    
                });
            });
        });
    };

    this.createImageTag = function(resource) {
        return '<br/><img hash="'+resource.data.bodyHash+'" type="'+resource.mime+'">';
    };
    
    this.createNoteResource = function(image) {
        var regex = /;base64,/;
        var res = regex.exec(image.getSrc());
        var mimetype = image.getSrc().substring(5, res.index);
        var data = image.getSrc().substring(res.index+8);

        var mimeRegex = /\//;
        res = mimeRegex.exec(mimetype);
        var filetype = mimetype.substring(res.index+1);
        
        var array = ArrayBufferHelper.b64ToArrayBuffer(data);
        var filename = image.getName()+'-'+image.getId()+'.'+filetype;
        return {
            noteGuid: null,
            mime: mimetype,
            data: {
                body: array.buffer,
                bodyHash: SparkMD5.ArrayBuffer.hash(array.buffer),
                size: array.length
            },
            attributes: new ResourceAttributes({
                fileName: filename
            })
        };
    };

    function initNoteStore() {
        if (!noteStore) {
            noteStoreTransport = new Thrift.BinaryHttpTransport(note_store_url);
            noteStoreProtocol = new Thrift.BinaryProtocol(noteStoreTransport, false, false);
            noteStore = new NoteStoreClient(noteStoreProtocol, noteStoreProtocol);
        }
    }
};

var ENMLofHTML = function(){
    var self = this;

    this.output = '';
    this.input = '';
    this.dom = null;

    this.parser = new DOMParser();

    this.writer = new XMLWriter;

    this.IGNORE_TAGS = [
        'applet',
        'base',
        'basefont',
        'bgsound',
        'blink',
        'body',
        'button',
        'dir',
        'embed',
        'fieldset',
        'form',
        'frame',
        'frameset',
        'head',
        'html',
        'iframe',
        'ilayer',
        'isindex',
        'label',
        'layer,',
        'legend',
        'link',
        'marquee',
        'menu',
        'meta',
        'noframes',
        'noscript',
        'object',
        'optgroup',
        'option',
        'param',
        'plaintext',
        'script',
        'select',
        'style',
        'textarea',
        'xml'
    ];
    this.IGNORE_ATTRS = [
        'id',
        'class',
        'onclick',
        'ondblclick',
        'on*',
        'accesskey',
        'data',
        'dynsrc',
        'tabindex',
        'src'
    ];

    this.parse = function(text) {
        self.input = text;
        self.dom = self.parser.parseFromString(text, 'text/html');
        if (self.dom.childNodes.length > 0) {
            self.writer.startDocument('1.0', 'UTF-8', false);
            self.writer.write('<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">');
            self.writer.write('<en-note>');
            for (var i=0; i < self.dom.childNodes.length; i++) {
                self.parseChild(self.dom.childNodes[i]);
            }
            self.writer.write('</en-note>');
        }

        return self;
    },

    this.parseChild = function(child) {
        if (child.nodeType == Node.ELEMENT_NODE) {
            var tag = child.tagName.toLowerCase();
            if (tag == 'br') {
                self.writer.write('<' + tag);
                if (child.attributes.length > 0) {
                    self.parseAttributes(child.attributes);
                }
                self.writer.write('/>');
            } else if (tag == 'img') {
                self.writer.write('<en-media');
                if (child.attributes.length > 0) {
                    self.parseAttributes(child.attributes);
                }
                self.writer.write('>');
                self.writer.write('</en-media>');
            } else if (tag == 'input') {
                if (child.getAttribute('type') == 'checkbox') {
                    self.writer.write('<en-todo');
                    if (child.getAttribute('checked')) {
                        self.writer.write(' checked="' + child.getAttribute('checked') + '"');
                    }
                    self.writer.write('>');
                    self.writer.write('</en-todo>');
                }
            } else {
                if (self.IGNORE_TAGS.indexOf(tag) == -1) {
                    self.writer.write('<' + tag);
                    if (child.attributes.length > 0) {
                        self.parseAttributes(child.attributes);
                    }
                    self.writer.write('>');
                }
                if (child.childNodes.length > 0) {
                    for (var i=0; i < child.childNodes.length; i++) {
                        self.parseChild(child.childNodes[i]);
                    }
                }
                if (self.IGNORE_TAGS.indexOf(tag) == -1) {
                    self.writer.write('</' + tag + '>');
                }
            }
        }

        if (child.nodeType == Node.TEXT_NODE) {
            var text = child.nodeValue.replace(/&(?!amp;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            self.writer.write(text);
        }
    },

    this.parseAttributes = function(attributes) {
        for (var i=0; i < attributes.length; i++) {
            if (self.IGNORE_ATTRS.indexOf(attributes[i].nodeName) == -1) {
                self.writer.write(' ' + attributes[i].nodeName + '="' + attributes[i].value + '"');
            }
        }
    },

    this.getOutput = function() {
        self.output = self.writer.toString();
        return self.output;
    }
};