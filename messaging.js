var db = require('./db.js');
var main = module.parent.exports;
var captcha = require('./captcha.js');
var buffer = require('./buffer.js');

// contacts: statuses: 0 = no invites, 1 = invited, pending action, 2 = accepted
// online status: 0 = Offline (Not a status, just an output), 1 = Normal, 2 = Busy, 3 = Do not disturb, 4 = Invisible

main.on("getLists", function(conn, data){
	// Fetch all my conversations
	if(conn.uid){
		db.redis.hget("user:" + conn.uid, "status", function(err, res){
			var myStatus = res;
			db.redis.hgetall("list:" + conn.uid, function(err, res){
				var returnArray = [];
				var remaining = 0;
				
				var newRes = [];
				
				for(var i in res){
					remaining++;
					if(i.length == 37){
						newRes.push([i, res[i]]);
					}
				}
				for(var i in res){
					if(i.length == 20){ // have rooms at the end
						newRes.push([i, res[i]]);
					}
				}
				
				
				for(var i in newRes){
					var uid;
					if(newRes[i][0].length == 20){
						uid = newRes[i][0].substr(4);
					} else {
						uid = newRes[i][0].substr(4).split("-");
						uid = (uid[0] == conn.uid ? uid[1] : uid[0]);
					}
					
					getListUnit(newRes[i][0], newRes[i][1], conn, conn.uid, uid, myStatus, function(result){ // get 
						returnArray.push(result);
						remaining--;
						if(remaining==0){
							conn.msg("getLists", {list: returnArray}); // send lists
						}
					});
				}
			});
		});
	}
});
function getListUnit(id, listRes, conn, addToUID, uid, myStatus, callback){
	db.redis.hmget("conv:" + id, "lastMessage", "usercount", function(err, resC){
		
		var lastRead = listRes.split("|")[1];
		var lastMyMessage = listRes.split("|")[0];
		var lastMessage = resC[0];
		
		if(lastMessage > lastRead || lastRead == 0){
			buffer.getConv(id, conn, true, true); // unread messages, get buffer
		}
		if(!main.roomSockets[id])
			main.roomSockets[id] = [];
		if(main.roomSockets[id].indexOf(addToUID) == -1)
			main.roomSockets[id].push(addToUID);
		main.userRoomSockets[addToUID].push(id);
		
		var rAconstruct = {uid: uid, id: id, lastMyMessage: lastMyMessage, lastMessage: resC[0], lastRead: lastRead, lastMessage: lastMessage, users: [], usercount: resC[1]}

		if(id.indexOf("-") != -1){
			db.redis.hmget("contacts:" + main.sortUID(addToUID, uid), "status", "requester", function(err, res2){
				// check contacts
				if(res2[0] !== null && res2[0] != 0){
					if(myStatus != 4 && res2[0] == 2){
						// notify that I'm online
						main.emitTo([uid], "", "statusUpdate", {target: addToUID, status: myStatus});
					}
					db.redis.hmget("user:" + uid, "username", "displayname", "status", "online", "avatar", "bgColor", function(err, res3){
						var statusReturn = (res3[3] == 1 ? res3[2] : 0);
						if(statusReturn == 4){
							statusReturn = 0;
						}
						var resRA = {contact: res2[0], myRequest: res2[1] === addToUID, username: res3[0], displayname: res3[1], status: statusReturn, avatar: res3[4], bgColor: res3[5]};
						if(res2[0] == 1){
							delete resRA.displayname;
							delete resRA.status;
							delete resRA.avatar;
						}
						if(!main.lastList[addToUID])
							main.lastList[addToUID] = [];
						if(main.lastList[addToUID].indexOf(uid) == -1)
							main.lastList[addToUID].push(uid);
						callback(main.merge(resRA, rAconstruct));
					});
				} else {
					db.redis.hmget("user:" + uid, "username", "bgColor", "avatar", function(err, res3){
						var resRA = {contact: 0, myRequest: false, username: res3[0], bgColor: res3[1]};
						callback(main.merge(resRA, rAconstruct));
					});
				}
			});
		} else {
			// room
			if(main.groupCallInfo[id] && main.groupCallInfo[id].users.length){
				rAconstruct.active = {state: "CALLING", myInitiate: false, callUsers: main.groupCallInfo[id].users, type: main.groupCallInfo[id].type};
			}
			db.redis.hmget("conv:" + id, "name", "hashname", "ranks", "avatar", function(err, res){
				rAconstruct.name = res[0];
				rAconstruct.hashname = res[1];
				if(!res[2]){
					res[2] = "{}";
					db.redis.hset("conv:" + id, "ranks", "{}");
				}
				var ranks = JSON.parse(res[2]);
				rAconstruct.myRank = ranks[addToUID] || 0;
				rAconstruct.avatar = res[3];
				callback(rAconstruct);
			});
		}
	});
}
main.on("addList", function(conn, data){
	if(conn.uid && data && data.addID){
		addListCall(data.addID, conn.uid, conn, false);
	}
});
main.on("createRoom", function(conn, data){
	if(conn.uid && data && data.roomID && data.name){
		if(data.roomID.length == 20){
			db.redis.hexists("conv:" + data.roomID, "name", function(err, res){
				if(res){
					console.log("Trying to create a room that already exists!");
				} else {
					// set room properties, then call addListCall
					data.name = data.name.substr(0,20);
					var ranksJSON = {};
					ranksJSON[conn.uid] = 9;
					ranksJSON = JSON.stringify(ranksJSON);
					db.redis.hmset("conv:" + data.roomID, "name", data.name, "users", "", "invited", conn.uid, "ranks", ranksJSON, "lastMessage", 0, "usercount", 0);
					addListCall(data.roomID, conn.uid, conn, false);
				}
			});
		}
	}
});
function addListCall(addingID, addToUID, addToConn, autojoin){
	// [addingID] to be added to [addingUID] with conn [addToConn]
	// autojoin = is an automatic addListCall generated from a message/contact request
	if(addingID.indexOf("-") != -1){
		var uid = addingID.substr(4).split("-"); // other user's UID
		uid = (uid[0] == addToUID ? uid[1] : uid[0]);
	}
	
	// lastYourCommunication (by your sent msg) | lastRead (by you)
	db.redis.hsetnx("list:" + addToUID, addingID, "0|0", function(err, res){
		if(res == 0)
			return; // do not add, already in list
		if(uid){
			db.redis.hmget("user:" + uid, "username", "status", "online", function(err, res){
				if(res[0]){
					if(addToConn){
						var showStatus = res[2] && res[2] != 4 ? res[1] : 0; // show status except for invisible, which shows as 0
						getListUnit(addingID, 0 + "|" + 0, addToConn, addToUID, uid, showStatus, function(data){
							addToConn.msg("newList", {object: main.merge(data, {created: true}), autojoin: autojoin});
						});
					}
				} else {
					db.redis.hdel("list:" + addToUID, addingID);
				}
			});
		}
		db.redis.hexists("conv:" + addingID, "lastMessage", function(err, res){
			if(res){
				db.redis.hmget("conv:" + addingID, "users", "name", "hashname", "invited", function(err, res){
					if(!uid){ // room handling
						if(!addToConn)
							return console.log("Must pass addToConn when joining room.");
							
						// Test that we are in the room's invited list so unauthorized people can't join
						var invites = res[3].split(",");
						if(res[1] && res[3].indexOf(addToUID) != -1){
							var newTime = new Date().getTime();
							getListUnit(addingID, 0 + "|" + 0, addToConn, addToUID, uid, -1, function(data){
								data.usercount++; // include myself in the usercount
								addToConn.msg("newList", {object: main.merge(data, {created: true})});
																
								if(res[0].split(",").indexOf(addToUID) == -1 && addingID.length == 20){
									res[0] += "," + addToUID;
									res[0] = res[0].replace(/^,|,$/, "");
									db.redis.hset("conv:" + addingID, "users", res[0]);
									db.redis.hincrby("conv:" + addingID, "usercount", 1);
								}
								
								onComm(addToConn, {type: 9, target: addingID, data: JSON.stringify({time: newTime}), auxdata: "-", internal: true}); // emit 'has joined'
							});
						} else { // not in invited list
							db.redis.hdel("list:" + addToUID, addingID);
							addToConn.msg("noInvite", {});
							return;
						}
					}
				});
			} else { // not set, so create it
				db.redis.hmset("conv:" + addingID, "lastMessage", 0, "users", addToUID, "usercount", 1);
			}
		});
	});
}
main.on("removeList", function(conn, data){
	if(conn.uid && data){
		onRemoveList(data, conn.uid, false);
	}
});
function onRemoveList(data, removeFromUID, kickedBy){
	// kickedBy can be false or [kickersUID, kickersUsername]
	if(removeFromUID && data && data.removeID){ // removeFromUID = remove from which user's list, removeID = removing
		db.redis.hdel("list:" + removeFromUID, data.removeID);
		if(data.removeID.length == 20){
			db.redis.hget("conv:" + data.removeID, "users", function(err, res){
				if(res){
					var newRes = res.replace(removeFromUID, "");
					newRes = newRes.replace(",,", ",").replace(/^,|,$/, "");
					if(newRes != res){
						db.redis.hincrby("conv:" + data.removeID, "usercount", -1);
					}
					db.redis.hset("conv:" + data.removeID, "users", newRes);
				}
			});
			// quit message
			onComm({uid: removeFromUID}, {type: 9, target: data.removeID, data: JSON.stringify({time: new Date().getTime(), quit: true, kickedByUID: (kickedBy ? kickedBy[0] : undefined), kickedByUsername: (kickedBy ? kickedBy[1] : undefined)}), auxdata: "-", internal: true});
			if(main.groupCallInfo[data.removeID] && main.groupCallInfo[data.removeID].users.indexOf(removeFromUID) !== -1){
				// remove if in call
				main.groupCallInfo[data.removeID].users.splice(main.groupCallInfo[data.removeID].users.indexOf(removeFromUID));
			}
		}
		if(main.roomSockets[data.removeID] && main.roomSockets[data.removeID].indexOf(removeFromUID) != -1){
			main.roomSockets[data.removeID].splice(main.roomSockets[data.removeID].indexOf(removeFromUID), 1);
			if(main.userRoomSockets[removeFromUID] && main.userRoomSockets[removeFromUID].indexOf(data.removeID) !== -1){
				main.userRoomSockets[removeFromUID].splice(main.userRoomSockets[removeFromUID].indexOf(data.removeID), 1);
			}
		}
	}
}
main.on("kickUser", function(conn, data){
	if(conn.uid && data && data.target && data.kicking && data.target.length == 20 && data.kicking.length == 16){
		main.usernameCache(conn.uid, function(connUsername){
			connUsername = connUsername[0];
			main.usernameCache(data.kicking, function(targetUsername){
				targetUsername = targetUsername[0];
				main.checkRank(data.target, conn.uid, 2, data.kicking, function(allowed){
					if(allowed){
						db.redis.hmget("conv:" + data.target, "users", "invited", "ranks", function(err, res){
							onRemoveList({removeID: data.target}, data.kicking, [conn.uid, connUsername]);
														
							res[1] = res[1].replace(data.kicking, "");
							res[1] = res[1].replace(",,", ",").replace(/^,|,$/, "");
							db.redis.hset("conv:" + data.target, "invited", res[1]);
							main.emitTo([data.kicking], "", "kicked", {target: data.target, kickerUID: conn.uid, kickerUsername: connUsername}); // tell user they've been kicked
						});
					}
				});
			});
		});
	}
});
main.on("getUsers", function(conn, data){
	if(conn.uid && data.target){
		db.redis.hmget("conv:" + data.target, "users", "ranks", "invited", function(err, res){
			if(res){
				var users = res[0].split(",");
				var ranks = JSON.parse(res[1]);
				var invites = res[2].split(",");
				var finalArray = [];
				var finalInvites = [];
				if(users.indexOf(conn.uid) != -1){
					for(var i = 0; i < invites.length; i++){
						if(users.indexOf(invites[i]) == -1){
							finalInvites.push(invites[i]);
						}
					}
					for(var i = 0; i < users.length; i++){
						new function(){
							var theUID = users[i];
							main.usernameCache(users[i], function(username){
								finalArray.push([username[0], theUID]);
								if(finalArray.length == users.length){
									conn.msg("userList", {target: data.target, users: finalArray, invites: finalInvites, ranks: ranks});
								} else {
								}
							});
						}();
					}
				}
			}
		});
	}
});
main.on("removeContact", function(conn, data){
	if(conn.uid && data.removeID && data.removeID.length > 4){
		db.redis.hmset("contacts:" + data.removeID.substr(4), "status", 0, "requester", "");
		
		var otherUID = data.removeID.substr(4).split("-");
		otherUID = (otherUID[0] == conn.uid ? otherUID[1] : otherUID[0]);
		
		main.emitTo([otherUID], "", "statusUpdate", {target: conn.uid, contact: 0, status: null});
		
		if(main.lastList[conn.uid]){
			if(main.lastList[conn.uid].indexOf(data.removeID) != -1)
				main.lastList[conn.uid].splice(main.lastList[conn.uid].indexOf(data.removeID), 1);
		}
		if(main.lastList[data.removeID]){ // Not scaling perfectly due to diff servers
			if(main.lastList[data.removeID].indexOf(conn.uid) != -1)
				main.lastList[data.removeID].splice(main.lastList[data.removeID].indexOf(conn.uid), 1);
		}
	}
});
main.on("clearHistory", function(conn, data){
	if(conn.uid && data.target){
		if(!data.time){
			db.redis.hset("history:" + conn.uid, data.target, new Date().getTime());
		} else {
			db.redis.hget("history:" + conn.uid, data.target, function(err, res){
				if(data.time > res && data.time < new Date().getTime()){
					db.redis.hset("history:" + conn.uid, data.target, data.time);
				}
			});
		}
	}
});
main.on("setUserRank", function(conn, data){
	if(conn.uid && typeof data.newRank != 'undefined' && data.target && data.user){
		if(data.user == conn.uid)
			return console.log("setting self");; // no setting self
		db.redis.hget("conv:" + data.target, "ranks", function(err, res){
			// not using main.checkRank as this logic is a bit more specialized
			var ranks = JSON.parse(res);
			var myRank = ranks[conn.uid] || 0;
			var theirRank = ranks[data.user] || 0;
			var newRank = data.newRank;
			if(myRank < 4){
				return;
			}
			if(myRank <= theirRank && myRank != 9){
				return;
			}
			if(myRank <= newRank && myRank != 9){
				return;
			}
			if(newRank != 0 && newRank != 2 && newRank != 4 && newRank != 9){
				return; 
			}
			if(newRank == 0){
				delete ranks[data.user];
			} else {
				ranks[data.user] = newRank;
			}
			db.redis.hset("conv:" + data.target, "ranks", JSON.stringify(ranks));
			main.usernameCache(data.user, function(username){
				// emit system message ('set rank to')
				onComm(conn, {type: 11, target: data.target, data: JSON.stringify({time: new Date().getTime(), targetUserUID: data.user, targetUserUsername: username[0], newRank: newRank}), auxdata: "-", internal: true});
			});
		});
	}
});

var commBufferCondition = []; // buffer sending of comms until condition finishes
// eg: keyexchange (with public key queried from DB) must be sent before any encrypted message
var commBuffer = [];

var invitedBuffer = [];

main.on("comm", onComm);

var convTargetRegex = new RegExp("^[A-Za-z0-9\-]+$");

function onComm(conn, data){
	if(conn.uid && data.target && data.data && data.auxdata && data.type && (data.type != 7 || data.inviteToRoom)){
		if(!convTargetRegex.test(data.target))
			return console.log("onComm: Skipped due to invalid target");
		// 1 keyExchange | 2 text message | 3 voice data | 4 voice+video data | 5 contact request | 6 init call | 7 invite to room | 8 'invited someone' message | 9 'joined room' message | 10 webRTC message | 11 set rank to
		// 8,9,11 non-encrypted, sent by server
		
		var otherUID = "";
		var emitToArray;
		if(!data.internal && (data.type == 8 || data.type == 9 || data.type == 11))
			return; //not generated internally
		if(data.target.length == 37){
			var uids = data.target.substr(4).split("-");
			if(uids.length == 2){
				if((uids[0] == conn.uid || uids[1] == conn.uid) && (uids[0] != uids[1])){
					otherUID = (uids[0] == conn.uid ? uids[1] : uids[0]);
				}
			}
			if(!otherUID)
				return;
			emitToArray = [conn.uid, otherUID];
		} else {
			if(!main.roomSockets[data.target])
				main.roomSockets[data.target] = [];
			
			emitToArray = main.roomSockets[data.target];
		}
			
		var emitNow = true;

		var currentTime = new Date().getTime();
		var emitObject = {sender: conn.uid, target: data.target, type: data.type, data: data.data, auxdata: data.auxdata, time: currentTime};
		
		if(data.clientTs){
			// send ACK with server timestamp
			conn.msg("ack", {sTs: currentTime, cTs: data.clientTs, target: data.target});
		}
		
		if(data.type == 1){
			// Key exchange
			if(data.target.length != 37)
				return;
			emitNow = false;
			commBufferCondition[data.target] = true;
			
			// detect key negotiation race condition
			if(typeof commBuffer[data.target] != "undefined"){
				conn.ignored = true;
				return conn.msg("reloadNeeded", {raceCondition: data.target});
			}
			
			commBuffer[data.target] = [];
			// Send keyExchange sender's public key
			db.sqlQuery("SELECT publicKey FROM users WHERE uid='" + conn.uid + "'", function(err, rows){
				emitObject.pubKey = rows[0].publicKey;
				main.emitTo([otherUID], "", "comm", emitObject);
				
				for(var i in commBuffer[data.target]){
					main.emitTo(emitToArray, conn.uid, "comm", commBuffer[data.target][i]);
				}
				commBuffer[data.target] = [];
				commBufferCondition[data.target] = false; 
			});
		} else if(data.type == 5 && data.target.length == 37){
			// Contact request / accept
			db.redis.hget("contacts:" + data.target.substr(4), "requester", function(err, res){
				if(res && res != null && res != conn.uid){
					// Other party already requested contacts, accept.
					db.redis.hset("contacts:" + data.target.substr(4), "status", 2);
					
					// Send details to accepted contact
					db.redis.hmget("user:" + conn.uid, "displayname", "status", "online", "avatar", function(err, res){
						emitObject.displayname = res[0];
						var statusReturn = (res[2] == 1 ? res[1] : 0);
						if(statusReturn == 4){
							statusReturn = 0;
						}
						main.emitTo(emitToArray, conn.uid, "statusUpdate", {target: conn.uid, displayname: res[0], status: statusReturn, contact: 2});
						main.emitTo(emitToArray, conn.uid, "avatar", {uid: conn.uid, avatar: res[3]});

					});
					// Send details to accepter
					db.redis.hmget("user:" + otherUID, "displayname", "status", "online", "avatar", function(err, res){
						var statusReturn = (res[2] == 1 ? res[1] : 0);
						if(statusReturn == 4){
							statusReturn = 0;
						}
						
						main.emitTo(emitToArray, otherUID, "statusUpdate", {target: otherUID, displayname: res[0], status: statusReturn, contact: 2});
						main.emitTo(emitToArray, otherUID, "avatar", {uid: otherUID, avatar: res[3]});
					});
					// Push to both parties lastList (contacts to notify when someone's status changes)
					if(!main.lastList[conn.uid])
						main.lastList[conn.uid] = [];
					if(main.lastList[conn.uid].indexOf(otherUID) == -1)
						main.lastList[conn.uid].push(otherUID);
						
					if(main.getConn(otherUID)){
						if(!main.lastList[otherUID])
							main.lastList[otherUID] = [];
						if(main.lastList[otherUID].indexOf(conn.uid) == -1)
							main.lastList[otherUID].push(conn.uid)
					}
				} else {
					// Record contact request
					db.redis.hmset("contacts:" + data.target.substr(4), "status", 1, "requester", conn.uid);
					main.emitTo(emitToArray, conn.uid, "statusUpdate", {target: conn.uid, contact: 1, myRequest: false});
					main.emitTo(emitToArray, otherUID, "statusUpdate", {target: otherUID, contact: 1, myRequest: true});
				}
			});
		} else if(data.type == 7){
			// invite to room
			if(data.target.length != 37)
				return;
			if(!invitedBuffer[data.inviteToRoom]){
				invitedBuffer[data.inviteToRoom] = [otherUID];
				// Check if inviter is supposed to be able to invite
				db.redis.hget("conv:" + data.inviteToRoom, "invited", function(err, res){
					if(res.indexOf(conn.uid) != -1){
						// Inviter is in invited list, can invite.
						invitedBuffer[data.inviteToRoom].filter(function(invitee){
							return res.indexOf(invitee) == -1; // don't invite duplicates
						});
						
						db.redis.hset("conv:" + data.inviteToRoom, "invited", res + invitedBuffer[data.inviteToRoom].join(","));
						delete invitedBuffer[data.inviteToRoom];
					} else {
						return; // inviter not supposed to invite
					}
				});
			} else {
				// buffer to bundle invites due to async db
				invitedBuffer[data.inviteToRoom].push(otherUID);
			}
			main.usernameCache(otherUID, function(username){
				// emit system message ('has invited')
				onComm(conn, {type: 8, target: data.inviteToRoom, data: JSON.stringify({time: new Date().getTime(), uid: otherUID, username: username[0]}), auxdata: "-", internal: true});
			});
		}
		if(data.target.length == 20 && (data.type == 2 || data.type == 11 || data.type >= 6 && data.type <= 9)){
			// room & displayed message, get color & username
			emitNow = false;
			main.usernameCache(conn.uid, function(username){
				emitObject.username = username[0];
				emitObject.bgColor = username[1];
				main.emitTo(emitToArray, conn.uid, "comm", emitObject);
			});
		}
		
		if(emitNow){
			if(commBufferCondition[data.target]){
				commBuffer[data.target].push(emitObject);
			} else {
				main.emitTo(emitToArray, conn.uid, "comm", emitObject);
			}
		}
		
		if(data.type == 1 || data.type == 2 || data.type == 5 || data.type == 11 || (data.type >= 7 && data.type <= 9)){
			// record in conv blob
			buffer.insertConv(data.target, data.type, data.data, data.auxdata, conn.uid, currentTime);
		}
		if(data.type == 2 || data.type == 5 || data.type == 11 || (data.type >= 7 && data.type <= 9)){
			// update lastRead, lastMessage
			db.redis.hget("list:" + conn.uid, data.target, function(err, res){
				if(res != null){
					db.redis.hset("list:" + conn.uid, data.target, currentTime + "|" + currentTime);
				}
			});
			db.redis.hset("conv:" + data.target, "lastMessage", currentTime);
			
			if(data.target.length == 37){
				// make other party add me to their list
				addListCall(data.target, otherUID, main.getConn(otherUID), true);
			}
		}
	}
}
main.on("markRead", function(conn, data){
	if(conn.uid && data && data.target){
		db.redis.hget("list:" + conn.uid, data.target, function(err, res){
			if(res){
				db.redis.hset("list:" + conn.uid, data.target, res.split("|")[0] + "|" + new Date().getTime());
			}
		});
	}
});
main.on("typingState", function(conn, data){
	if(conn.uid && data && data.target && data.state && (data.state == "typing" || data.state == "typed" || data.state == "empty")){
		if(main.roomSockets[data.target]){
			main.emitTo(main.roomSockets[data.target], conn.uid, "typingState", {uid: conn.uid, target: data.target, state: data.state});
		}
	}
});

main.on("setActive", function(conn, data){
	if(conn.uid && data && data.target && data.type && (data.type == "voice" || data.type == "video")){
		conn.activeCall = data.target;
		if(data.target.length == 20){
			db.redis.hget("conv:" + data.target, "users", function(err, res){
				if(res.indexOf(conn.uid) != -1){
					if(!main.groupCallInfo[data.target]){
						main.groupCallInfo[data.target] = {users: [conn.uid], type: data.type};
					} else {
						main.groupCallInfo[data.target].users.push(conn.uid);
						if(main.groupCallInfo[data.target].users.length == 0){
							main.groupCallInfo[data.target].type = data.type;
						}
					}
				}
			});
		}
	}
});
main.on("dropActive", function(conn, data){
	if(conn.uid && data && data.target){
		if(main.groupCallInfo[data.target]){
			if(main.groupCallInfo[data.target].users.indexOf(conn.uid) != -1){
				main.groupCallInfo[data.target].users.splice(main.groupCallInfo[data.target].users.indexOf(conn.uid), 1);
			}
		}
	}
});
var tmpFpHolder = [];
main.on("verifyFingerprint", function(conn, data){
	if(conn.uid && data.uid && data.remoteFingerprint && data.localFingerprint){
		if(tmpFpHolder[main.sortUID(conn.uid, data.uid)]){
			var myFpHolder = tmpFpHolder[main.sortUID(conn.uid, data.uid)];
			if(myFpHolder.remote === data.localFingerprint && myFpHolder.local === data.remoteFingerprint){
				main.emitTo([conn.uid, data.uid], [], "verifyFingerprint", {result: "SUCCESS", uids: [conn.uid, data.uid]});
			} else {
				console.log("!! Failed fingerprint verification: ", conn.uid, data.uid, myFpHolder.remote, data.localFingerprint, myFpHolder.local, data.remoteFingerprint);
				main.emitTo([conn.uid, data.uid], [], "verifyFingerprint", {result: "FAIL",  uids: [conn.uid, data.uid]});
			}
			delete tmpFpHolder[main.sortUID(conn.uid, data.uid)];
		} else {
			tmpFpHolder[main.sortUID(conn.uid, data.uid)] = [];
			var myFpHolder = tmpFpHolder[main.sortUID(conn.uid, data.uid)];
			var firstUser = main.sortUID(conn.uid, data.uid).substr(0,16) == conn.uid;
			myFpHolder.remote = data.remoteFingerprint; // remote and local from the first person who created it
			myFpHolder.local = data.localFingerprint;
			setTimeout(function(){
				if(tmpFpHolder[main.sortUID(conn.uid, data.uid)]){
					console.log("!! Fingerprint verification timed out: ", conn.uid, data.uid);
					main.emitTo([conn.uid, data.uid], [], "verifyFingerprint", {result: "FAIL", uids: [conn.uid, data.uid]});
				}
			}, 20000);
		}
	}
});
main.on("1", function(conn, raw){ // raw audio packet
	return; //unused
	if(conn.uid && raw){
		if(raw.length > 64){
			var iv = raw.substr(0,16);
			var payload = raw.substr(16);
			if(conn.activeCall){
				if(conn.activeCall.length == 37){
					var emitTo = conn.activeCall.substr(4).split("-");
					emitTo = (emitTo[0] == conn.uid ? emitTo[1] : emitTo[0]);
					main.emitTo([emitTo], "", "raw", "1" + raw);
				} else if(conn.activeCall.length == 20){
					// should use 2
				}
			}
		}
	}
});
main.on("2", function(conn, raw){
	return; //unused
	if(conn.uid && raw){
		if(raw.length > 64){
			var sender = raw.substr(0,1);
			var iv = raw.substr(1,17);
			var payload = raw.substr(17);
			if(conn.activeCall){
				if(conn.activeCall.length == 20){
					main.emitTo(main.groupCallInfo[conn.activeCall].users, conn.uid, "raw", "2" + raw)
				}
			}
		}
	}
});
