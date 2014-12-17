var db = require('./db.js');
var main = module.parent.exports;
var fs = require('fs');

main.on("getBuffer", function(conn, data){
	if(conn.uid && data && data.target){
		db.redis.hget("conv:" + data.target, "users", function(err, res){
			if((data.target.length == 37 && data.target.indexOf(conn.uid) != -1) || res.indexOf(conn.uid) != -1){
				getConv(data.target, conn, true, data.small);
			} else {
				conn.msg("commBundle", {bundle: [], target: data.target, small: false});
			}
		});
	}
});

var commBufferNext = []; // Added in next swoop
var commBufferPending = []; // Pending to be added
var commBufferNextBusy = [];
function insertConv(target, type, data, auxdata, senderuid, time){
	var armored = main.armor(type, data, auxdata, senderuid, time);
	var armoredLength = armored.length;
	
	if(!commBufferNext[target]){
		commBufferNext[target] = [armored, armoredLength];
		commBufferNextBusy[target] = false;
	} else {
		commBufferNext[target][0] += armored;
		commBufferNext[target][1] += armoredLength;
	}
	if(!commBufferNextBusy[target]){
		processNextCommBuffer(target);
	}
}
module.exports.insertConv = insertConv;
function processNextCommBuffer(target){
	// Cleanup for previous calls
	commBufferNextBusy[target] = false;
	commBufferPending[target] = "";
	
	if(commBufferNext[target] && commBufferNext[target].length && commBufferNext[target][1] > 0){
		commBufferNextBusy[target] = true;
		
		// Move to pending
		commBufferPending[target] = commBufferNext[target][0];
		
		var combinedArmored = new Buffer(commBufferNext[target][0], "binary").toString("hex"); // converted to hex
		var combinedArmoredLength = commBufferNext[target][1];
		
		commBufferNext[target] = ["", 0]; // Clear next
		
		db.sqlQuery("SELECT LENGTH(blobbuffer) as bufferLength FROM conv WHERE id=" + db.escape(target), function(err, rows){
			if(rows.length == 0 && combinedArmoredLength < (64 * 1024)){
				// create new row
				db.sqlQuery("INSERT INTO conv(id, blobbuffer) VALUES(" + db.escape(target) + ", 0x" + combinedArmored + ")", function(err, rows){
					processNextCommBuffer(target);
				});
				
			} else {
				if(parseInt(rows[0].bufferLength) + parseInt(combinedArmoredLength) > (64 * 1024)){
					// need to overwrite earlier history
					var cutFront = (50 * 1024) + combinedArmoredLength;
					db.sqlQuery("UPDATE conv SET blobbuffer=CONCAT(SUBSTR(blobbuffer, -" + cutFront + "), 0x" + combinedArmored + ") WHERE id=" + db.escape(target), function(err, rows){
						processNextCommBuffer(target);
					});
				} else {
					// simply append
					db.sqlQuery("UPDATE conv SET blobbuffer=CONCAT(blobbuffer, 0x" + combinedArmored + ") WHERE id=" + db.escape(target), function(err, rows){
						processNextCommBuffer(target);
					});
				}
			}
		});
	}
}
// probably scope issues
function getConv(conv, conn, wantKeyExchange, small){
	var theQuery = "SELECT blobbuffer FROM conv WHERE id=" + db.escape(conv);
	if(small){ // only return last 4kb
		theQuery = "SELECT RIGHT(blobbuffer, " + (4 * 1024) + ") AS blobbuffer FROM conv WHERE id=" + db.escape(conv);
	}
	db.redis.hget("history:" + conn.uid, conv, function(err, historyRes){
		db.sqlQuery(theQuery, function(err, rows){
			var blob = "";
			if(rows[0] && rows[0].blobbuffer.length){
				blob += rows[0].blobbuffer.toString("binary");
			}
			if(commBufferPending[conv]){
				blob += commBufferPending[conv];
			}
			if(commBufferNext[conv] && commBufferNext[conv][0]){
				blob += commBufferNext[conv][0];
			}
			if(blob.length > 0){
				if(blob.length < 4 * 1024)
					small = false; // we don't have a larger buffer, so this is large.
				
				var unarmored = main.unarmor(blob);
				var unarmoredLength = unarmored.length;
				var usernameLookupsLeft = (conv.length == 20 ? unarmoredLength : 0);
				var sendBuffer = [];
				
				for(var i = 0; i < unarmored.length; i++){
					var messageType = unarmored[i][0];
					var messageData = unarmored[i][1];
					var messageAuxdata = unarmored[i][2];
					var senderUID = unarmored[i][3];
					var messageTime = unarmored[i][4];
					if(historyRes && historyRes >= messageTime){
						small = false;
						unarmoredLength--;
						if(usernameLookupsLeft)
							usernameLookupsLeft--;
						continue;
					}
					if(messageType == 1){
						if(wantKeyExchange){
							// delay sending until we get the public key
							new function(){
								var unshifted = {type: messageType, data: messageData, auxdata: messageAuxdata, sender: senderUID, time: messageTime};
								var searchUID = (conv.substr(4).split("-")[0] == conn.uid ? conv.substr(4).split("-")[1] : conv.substr(4).split("-")[0]);
								db.sqlQuery("SELECT publicKey FROM users WHERE uid='" + searchUID + "'", function(err, rows){
									if(rows && rows[0] && rows[0].publicKey){
										unshifted.pubKey = rows[0].publicKey;
										sendBuffer.unshift(unshifted);
										if(sendBuffer.length == unarmoredLength){
											// okay, let's send!
											conn.msg("commBundle", {bundle: sendBuffer, target: conv, small: small});
											sendBuffer = [];
										}
									}
								});
							}();
						} else {
							unarmoredLength--;
						}
					} else {
						var closureClosure = function(){
							var pushed = sendBuffer.push({type: messageType, data: messageData, auxdata: messageAuxdata, sender: senderUID, time: messageTime});
							if(conv.length==20){
								main.usernameCache(senderUID, function(username){
									sendBuffer[pushed-1].username = username[0];
									sendBuffer[pushed-1].bgColor = username[1];
									usernameLookupsLeft--;
									if(usernameLookupsLeft==0){
										conn.msg("commBundle", {bundle: sendBuffer, target: conv, small: small});
										sendBuffer = [];
									}
								});
							} else {
								if(sendBuffer.length == unarmoredLength){
									conn.msg("commBundle", {bundle: sendBuffer, target: conv, small: small});
									sendBuffer = [];
								}
							}
						}();
					}
				}
				if(sendBuffer.length == unarmoredLength && conv.length == 37){
					conn.msg("commBundle", {bundle: sendBuffer, target: conv, small: small});
				}
			} else {
				setTimeout(function(){
					conn.msg("commBundle", {bundle: [], target: conv, small: false});
					// delay in case of addList so this does not arrive prior
				}, 250);
			}
		})
	});
}
module.exports.getConv = getConv;
