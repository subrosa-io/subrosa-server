var db = require('./db.js');
var main = module.parent.exports;
var gm = require('gm');
var fs = require('fs');
var exec = require('child_process').exec;
var captcha = require('./captcha.js');

var allowedBgColors = ["EDFBFF", "EDECFC", "F2E8FF", "F3DAFF", "FCE1F9", "FFECEF", "FFF5E8", "FFF9E8", "FEFFE8", "E8FDE5", "E9FFD2", "FCFDFC"];
main.on("userExists", function(conn, data){
	if(data.username){
		if(data.username.length<3){
			return conn.msg("userExists", {username: data.username, exists: false, error: "Too short."});
		}
		if(data.username.length>16){
			return conn.msg("userExists", {username: data.username, exists: false, error: "Too long."});
		}
		if(data.username.toLowerCase().indexOf("subrosa") != -1 || data.username.toLowerCase().indexOf("admin") != -1){
			return conn.msg("userExists", {username: data.username, exists: false, error: "Reserved."});
		}
		if(!data.username.match(/^[A-z0-9\-\.]*$/g)){
			return conn.msg("userExists", {username: data.username, exists: false, error: "Invalid characters."});
		}
		db.sqlQuery("SELECT uid FROM users WHERE username=" + db.escape(data.username), function(err, rows){
			conn.msg("userExists", {username: data.username, exists: (rows.length === 1), uid: (rows[0] ? rows[0].uid : "")});
		});
	}
});
main.on("register", function(conn, data){
	if(data.username && data.displayname && typeof data.email != 'undefined' && data.challenge && data.captcha && typeof data.newsletter != 'undefined' && data.derivedKeyHash && data.publicKey && data.encryptedBlob){
		if(data.username.length<3)
			return conn.msg("register", {status: "FAIL", message: "Username is too short.", restart: true});
		if(data.username.length>16)
			return conn.msg("register", {status: "FAIL", message: "Username is too long.", restart: true});
		if(!data.username.match(/^[A-z0-9\-\.]*$/g))
			return conn.msg("register", {status: "FAIL", message: "Username contains invalid characters.", restart: true});
		if(data.displayname.length<3)
			return conn.msg("register", {status: "FAIL", message: "Display name is too short.", restart: true});
		if(data.username.toLowerCase().indexOf("subrosa") != -1 || data.username.toLowerCase().indexOf("admin") != -1)
			return conn.msg("register", {status: "FAIL", message: "Username contains reserved characters.", restart: true});
		if(data.displayname.length>30)
			data.displayname = data.displayname.substr(0, 30);
		if(data.email.length<6 || data.email.indexOf("@") == -1 || data.email.indexOf(".") == -1)
			data.email = "email@skipped.com";
		if(!data.encryptedBlob.iv || !data.encryptedBlob.salt || !data.encryptedBlob.kdf || !data.encryptedBlob.data)
			return conn.msg("register", {status: "FAIL", message: "Something went wrong with your encryption key. Please try again.", restart: true});
		if(data.encryptedBlob.iv.length != 16 || data.encryptedBlob.salt.length != 32 || data.encryptedBlob.kdf.length != 3 || data.encryptedBlob.data.length < 1000 || data.derivedKeyHash.length != 64 || data.publicKey.length < 100)
			return conn.msg("register", {status: "FAIL", message: "Something went wrong with your encryption key.. Please try again.", restart: true});
		db.sqlQuery("SELECT COUNT(*) AS usernameUnique FROM users WHERE username=" + db.escape(data.username), function(err, rows){
			if(rows[0]['usernameUnique'] == 0){
				if(captcha.checkCaptcha(data.challenge, data.captcha)){
					var uid = randomUID();
					
					db.sqlQuery("INSERT INTO users(uid, username, displayname, email, newsletter, passwordhash, publickey, ivBin, saltBin, kdf, userblob, lastaccess) VALUES('" + uid + "', " + db.escape(data.username) + ", " + db.escape(data.displayname) + ", " + db.escape(data.email) + ", " + (data.newsletter?1:0) + ", " + db.escape(data.derivedKeyHash) + ", " + db.escape(data.publicKey) + ", 0x" + binaryStringToHex(data.encryptedBlob.iv) + ", 0x" + binaryStringToHex(data.encryptedBlob.salt) + ", " + db.escape(data.encryptedBlob.kdf) + ", " + db.escape(data.encryptedBlob.data) + ", NOW())", function(err, rows){
						if(err)
							return console.log("DB Error when registering: " + err);
							
						
						db.redis.hset("user:" + uid, "username", data.username);
						db.redis.hset("user:" + uid, "displayname", data.displayname);
						db.redis.hset("user:" + uid, "status",  1);
						db.redis.hset("user:" + uid, "bgColor", allowedBgColors[Math.floor(Math.random()*allowedBgColors.length)]);
						genAvatar(uid);
						return conn.msg("register", {status: "OK"});
					});
				} else {
					return conn.msg("register", {status: "FAIL", id: "CAPTCHA", message: "The CAPTCHA is incorrect. Please try again.", restart: false});
				}
			} else {
				return conn.msg("register", {status: "FAIL", message: "Someone took your username while you were registering! Try another.", restart: true});
			}
		});
	}
});
main.on("loginMain", function(conn, data){
	if(data.step){
		if(data.step == 1 && data.username){
			db.sqlQuery("SELECT HEX(saltBin) AS saltHex, kdf FROM users WHERE username=" + db.escape(data.username), function(err, rows){
				if(!rows || rows.length == 0){
					return conn.msg("loginMain", {step: 1, status: "FAIL", message: "Username does not exist."});
				} else {
					var salt = new Buffer(rows[0].saltHex, 'hex').toString('binary');
					return conn.msg("loginMain", {step: 1, status: "OK", salt: salt, kdf: rows[0].kdf});
				}
			});
		} else if(data.step == 2 && data.hash){
			db.sqlQuery("SELECT uid, passwordhash FROM users WHERE username=" + db.escape(data.username), function(err, rows){
				if(rows[0] && rows[0].passwordhash && rows[0].uid){
					setTimeout(function(){
						if(rows[0].passwordhash === data.hash){
							conn.uid = rows[0].uid;
							main.setUID(conn);
							db.redis.hset("user:" + conn.uid, "online", 1);
							
							main.userRoomSockets[conn.uid] = [];
							
							if(typeof data.resendBlob != 'undefined' && data.resendBlob == false)
								return main.map["getLists"](conn, {});

							db.sqlQuery("SELECT HEX(ivBin) AS ivHex, userblob, displayname FROM users WHERE username=" + db.escape(data.username), function(err, rows2){
								if(rows2[0] && rows2[0].ivHex && rows2[0].userblob){
									
									var iv = new Buffer(rows2[0].ivHex, 'hex').toString('binary');
									
									db.redis.hmget("user:" + conn.uid, "status", "avatar", "bgColor", function(err, res){
										conn.msg("loginMain", {step: 2, status: "OK", iv: iv, userBlob: rows2[0].userblob, uid: rows[0].uid, displayname: rows2[0].displayname, username: data.username, status: res[0], avatar: res[1], bgColor: res[2]});
										return main.map["getLists"](conn, {});
									});
								}
							});
						} else {
							return conn.msg("loginMain", {step: 2, status: "FAIL", message: "Password incorrect."});
						}
					}, 20);
				}
			});
		}
	}
});
main.on("updateBlob", function(conn, data){
	if(data.iv && data.blob && conn.uid){
		if(data.iv.length == 16 && data.blob.length > 500){
			db.sqlQuery("UPDATE users SET ivBin=0x" + binaryStringToHex(data.iv) + ", userblob=" + db.escape(data.blob) + " WHERE uid='" + conn.uid + "'", function(err, rows){
				if(err){
					return console.log("MySQL error while updating blob:" + err);
				}
			});
		}
	}
});
main.on("getPubKey", function(conn, data){
	if(conn.uid && data.uid){
		db.sqlQuery("SELECT publickey FROM users WHERE uid=" + db.escape(data.uid), function(err, rows){
			if(rows[0] && rows[0].publickey){
				conn.msg("getPubKey", {uid: data.uid, pubKey: rows[0].publickey});
			}
		});
	}
});
main.on("changeStatus", function(conn, data){
	if(conn.uid && data && data.status && typeof data.status == "number"){
		db.redis.hset("user:" + conn.uid, "status", data.status);
		for(var i in main.lastList[conn.uid]){
			main.emitTo([main.lastList[conn.uid][i]], "", "statusUpdate", {target: conn.uid, status: (data.status == 4 ? 0 : data.status)});
		}
	}
});
main.on("changeProfile", function(conn, data){
	if(conn.uid && data){
		if(data.displayname && data.displayname !== "*"){
			data.displayname = data.displayname.substr(0, 30);
			db.redis.hset("user:" + conn.uid, "displayname", data.displayname);
			db.sqlQuery("UPDATE users SET displayname=" + db.escape(data.displayname) + " WHERE uid='" + conn.uid + "'");
			for(var i in main.lastList[conn.uid]){
				main.emitTo([main.lastList[conn.uid][i]], "", "statusUpdate", {target: conn.uid, displayname: data.displayname});
			}
		}
		if(data.derivedKeyHash && data.derivedKeySalt && data.derivedKeyKdf){
				db.sqlQuery("UPDATE users SET passwordHash=" + db.escape(data.derivedKeyHash) + ", saltBin=0x" + binaryStringToHex(data.derivedKeySalt) + ", kdf=" + db.escape(data.derivedKeyKdf) + " WHERE uid='" + conn.uid + "'");
		}
		if(data.bgColor && typeof data.bgColor == "string"){
			if(allowedBgColors.indexOf(data.bgColor) != -1){
				db.redis.hset("user:" + conn.uid, "bgColor", data.bgColor);
			}
		}
	}
});
main.on("changeGroupInfo", function(conn, data){
	if(conn.uid && data){
		// check rank to be admin+
		db.redis.hmget("conv:" + data.target, "users", "ranks", function(err, res){
			if(!res)
				return;
			var ranks = JSON.parse(res[1]);
			if(res[0].indexOf(conn.uid) != -1 && ranks[conn.uid] >= 4){
				if(data.name){
					data.name = data.name.substr(0, 20);
					db.redis.hset("conv:" + data.target, "name", data.name);
					main.emitTo(main.roomSockets[data.target], conn.uid, "groupUpdate", {target: data.target, name: data.name});
				}
			}
		});
	}
});
main.on("filePart", function(conn, data){
	if(conn.uid && data && data.t && typeof data.p != 'undefined' && data.d){
		if(!conn.fileContinue)
			conn.fileContinue = "";
		if(data.target)
			conn.fileUploadTarget = data.target;
		if(data.d.length > 10240){
			return;
		} else if(data.p == 0){
			conn.fileContinue += data.d;
			if(conn.fileUploadTarget){
				if(conn.fileUploadTarget == "self"){
					setAvatar(conn, conn.uid, conn.fileContinue); 
					conn.fileContinue = "";
					conn.fileUploadTarget = "";
				} else if(conn.fileUploadTarget.length == 20){
					main.checkRank(conn.fileUploadTarget, conn.uid, 4, "", function(allowed){
						if(allowed){
							setAvatar(conn, conn.fileUploadTarget, conn.fileContinue);
							conn.fileContinue = "";
							conn.fileUploadTarget = "";
						}
					});
				}
			}
		} else {
			if(conn.fileContinue.length < 2048 * 1024){
				conn.fileContinue += data.d;
				conn.msg("gotPart", {});
			}
		}
	}
});
function setAvatar(conn, target, fileRaw){
	var tempFile = "./tmp/" + Math.round(Math.random()*9999999);
	var fileBuffer = new Buffer(fileRaw, "binary");
	fs.open(tempFile, "w", function(err, fd){
		fs.write(fd, fileBuffer, 0, fileBuffer.length, 0, function(err, written, buffer){
			db.sqlQuery("INSERT INTO avatars(uid, avatar) VALUES('" + target + "', 0x" + fileBuffer.toString("hex") + ")");
			gm(tempFile).resize(60, 60).quality(84).write(tempFile + ".jpg", function(err1){
				if(err1){
					console.log(err1);
					conn.msg("avatarSet", {error: true, target: (target == conn.uid ? "self" : target)});
					fs.unlink(tempFile + ".jpg");
					fs.unlink(tempFile);
				} else {
					fs.readFile(tempFile + ".jpg", function(err2, fileData){
						var encoded = "data:image/jpeg;base64," + fileData.toString("base64");
						conn.msg("avatarSet", {newAvatar: encoded, target: (target == conn.uid ? "self" : target)});
						fs.unlink(tempFile + ".jpg");
						fs.unlink(tempFile);
						
						if(target == conn.uid){
							db.redis.hset("user:" + target, "avatar", encoded);
							for(var i in main.lastList[conn.uid]){
								main.emitTo([main.lastList[conn.uid][i]], "", "avatar", {uid: conn.uid, avatar: encoded});
							}
						} else {
							db.redis.hset("conv:" + target, "avatar", encoded);
							main.emitTo(main.roomSockets[target], conn.uid, "avatar", {id: target, avatar: encoded});
						}
					});
				}
			});
		});
	});
}
function genAvatar(uid){
	var colors = ["2fbe1e", "279a19", "eecf27", "21b8db", "321ae1", "e11ade", "f85757", "1d5495", "f689ea", "a82f0f", "41fff2", "ff7641"];
	// replace with a better random avatar generation
	exec("gm convert -size 180x180 plasma: -filter Point -crop 60x60+60+60 -quality 75 ./tmp/avatar.jpg", function(err1){
		if(err1)
			console.log(err1);
		fs.readFile("./tmp/avatar.jpg", function(err2, fileData){
			var encoded = "data:image/jpeg;base64," + fileData.toString("base64");
			db.redis.hset("user:" + uid, "avatar", encoded);
		});
	});
}
function randomColor(colorArray){
	return colorArray.splice(Math.floor(Math.random()*colorArray.length, 1));
}
function randomUID(){
    var s= '';
    var randomchar=function(){
    	var n= Math.floor(Math.random()*62);
    	if(n<10) return n; //1-10
    	if(n<36) return String.fromCharCode(n+55); //A-Z
    	return String.fromCharCode(n+61); //a-z
    }
    while(s.length< 16) s+= randomchar();
    return s;
}
function binaryStringToHex(binaryString){
	return new Buffer(binaryString, 'binary').toString('hex');
}
main.on("errorReport", function(conn, data){
	console.log("** Client err " + new Date().toString(), data.trace, "UID: " + (conn.uid ? conn.uid : " none"));
});
