createExports();
var db = require("./db.js");
var captcha = require('./captcha.js');
var users = require("./users.js");
var buffer = require("./buffer.js");
var messaging = require("./messaging.js");
var http = require('http');
var util = require('util');
var fs = require("fs");
var WebSocketServer = require('ws').Server;

var wss = new WebSocketServer({port: 4000});

var connections = [];
var uidConn = {};
var _usernameCache = {};
var setConnProto = false;

wss.on("connection", function(conn){
	if(!setConnProto){
		conn.constructor.prototype.msg = function(type, message){ if(this.readyState == this.OPEN){ message.sockType=type; this.send(JSON.stringify(message)) } };
		setConnProto=true;
	}
	conn.heartbeat = true;
	connections.push(conn);
	conn.on("message", function(message){
		if(conn.ignored)
			return;
		if(message.length>0){
			if(message[0] == "{"){
				try {
					message = JSON.parse(message);
				} catch ( error ) {
					console.log("Invalid JSON message received:" + error);
				}
				if(message.sockType){
					if(module.exports.map[message.sockType]){
						module.exports.map[message.sockType](conn, message);
					} else {
						console.log("Unrecognized mapping: " + message.sockType);
					}
				} else {
					console.log("No message type specified:" + message.sockType);
				}
			} else {
				// herbeat response
				conn.heartbeat = true;
			}
		}
	});
	conn.on("close", function(message){
		connections.splice(connections.indexOf(conn), 1);
		if(conn.uid){
			db.redis.hset("user:" + conn.uid, "online",  0);

			var uR = module.exports.userRoomSockets[conn.uid];
			var rS = module.exports.roomSockets;
			var gCI = module.exports.groupCallInfo;

			for(var i in uR){ // for every room I'm in
				if(rS[uR[i]] && rS[uR[i]].indexOf(conn.uid) !== -1){
					rS[uR[i]].splice(rS[uR[i]].indexOf(conn.uid), 1); // remove from the room socket list
				}
				if(gCI[uR[i]] && gCI[uR[i]].users.indexOf(conn.uid) != -1){ // if in a group call
					gCI[uR[i]].users.splice(gCI[uR[i]].users.indexOf(conn.uid), 1); // remove from group call
					module.exports.emitTo(rS[uR[i]], "", "statusUpdate", {target: conn.uid, status: 0}); // send offline (parsed by clients as exiting group call)
				}
			}

			uR = [];

			for(var i in module.exports.lastList[conn.uid]){
				if(uidConn[module.exports.lastList[conn.uid][i]]){ // send offline to contacts
					uidConn[module.exports.lastList[conn.uid][i]].msg("statusUpdate", {target: conn.uid, status: 0});
				}
			}

			uidConn[conn.uid] = null;
		}
	});
});

setInterval(function(){
	for(var i = 0; i < connections.length; i++){
		if(connections[i] && connections[i].send){
			connections[i].heartbeat = false;
			try {
				connections[i].send("*"); // send hearbeat
			} catch (error) {
			}
		}
	}
	setTimeout(function(){
		connections.filter(function(conn){
			if(!conn.heartbeat){
				conn.close();
				return false;
			}
			return true;
		});
	}, 20 * 1000);
}, 20 * 1000);

var lastVersionCheck = -1;
var lastVersionData = "";
module.exports.on("version", function(conn, data){
	if(new Date().getTime() > lastVersionCheck + (60 * 1000)){
		fs.readFile("version", function(err, data){
			lastVersionData = JSON.parse(data);
			lastVersionData.time = new Date().getTime();
			lastVersionCheck = new Date().getTime();
			conn.msg("version", lastVersionData);
		});
	} else {
		lastVersionData.time = new Date().getTime();
		conn.msg("version", lastVersionData);
	}
});
var lastNewsCheck = -1;
var lastNewsData = "";
module.exports.on("news", function(conn, data){
	if(new Date().getTime() > lastNewsCheck + (60 * 1000)){
		fs.readFile("news", function(err, data){
			lastNewsData = JSON.parse(data);
			lastNewsCheck = new Date().getTime();
			conn.msg("news", {news: lastNewsData});
		});
	} else {
		conn.msg("news", {news: lastNewsData});
	}
});
function createExports(){
	module.exports.map = {};
	module.exports.on = function(type, callback){
		if(module.exports.map[type]){
			console.log("WARNING: Rebinding for " + type);
		}
		module.exports.map[type] = callback;
	}
	module.exports.sortUID = function(uid1, uid2){
		var sorted = [uid1, uid2].sort();
		return sorted[0] + "-" + sorted[1];
	}
	module.exports.setUID = function(conn){
		if(conn.uid){
			uidConn[conn.uid] = conn;
		}
	}
	module.exports.emitTo = function(toUIDarray, exceptUID, type, data){
		if(true){
			for(var i = 0; i < toUIDarray.length; i++){
				if(toUIDarray[i] !== exceptUID && uidConn[toUIDarray[i]]){
					uidConn[toUIDarray[i]].msg(type, data);
				}
			}
		} else {
			// different server, tbd
		}
	}
	module.exports.lastList = [];
	module.exports.roomSockets = [];
	module.exports.userRoomSockets = []; // a list of roomSockets a user is in, so they can be exited when user quits
	module.exports.getConn = function(uid){
		if(uidConn[uid]){
			return uidConn[uid];
		}
		return false;
	}
	module.exports.usernameCache = function(uid, callback){
		// returns [username, bgColor]
		if(_usernameCache[uid])
			return callback(_usernameCache[uid]);
		db.redis.hmget("user:" + uid, "username", "bgColor", function(err, res){
			if(res){
				callback(res);
				_usernameCache[uid] = res;
			} else {
				return callback(["", ""]);
			}
		});
	};
	module.exports.checkRank = function(roomid, uid, rankRequired, performingOnUID, callback){
		db.redis.hmget("conv:" + roomid, "users", "ranks", function(err, res){
			if(res[0].indexOf(uid) != -1){
				var ranks = JSON.parse(res[1]);
				if(!ranks[uid] || ranks[uid] < rankRequired)
					return callback(false);
				if(performingOnUID && ranks[uid] <= ranks[performingOnUID] && ranks[uid] != 9)
					return callback(false);
				callback(true);
			}
		});
	};
	module.exports.merge = function(obj1, obj2){ // merge two objects
		var obj3 = {};
		for (var attrname in obj1) { obj3[attrname] = obj1[attrname]; }
		for (var attrname in obj2) { obj3[attrname] = obj2[attrname]; }
		return obj3;
	}
	module.exports.armor = function(){
		// ^ to denote in-item seperator and & to denoate item seperator, at start
		// escape char: !
		// &1^themaindata^auxdata&1^another!^main!!data^auxda!&ta
		var output = "";
		for(var i = 0; i < arguments.length; i++) {
			output += arguments[i].toString().replace(/!/g, "!!").replace(/\^/g, "!^").replace(/\&/g, "!&") + "^";
		}
		return "&" + output.substr(0, output.length-1); // cut off trailing ^
	}
	module.exports.groupCallInfo = [];
	module.exports.unarmor = function(input){
		// designed to work directly from a mysql conv buffer
		var output = [];
		var il = input.length;
		var selecting = false;
		var currentObj = [];
		var currentItem = "";

		for(var i = 0; i < il; i++){
			if(!selecting){
				if(input[i] == "&" && (i == 0 || input[i-1] != "!")){
					selecting = true;
				}
			} else {
				if(input[i] == "!" && i != il-1){
					if(i != il-2){
						currentItem += input[i+1];
						i++;
					}
				} else if(input[i] == "^"){
					currentObj.push(currentItem);
					currentItem = "";
				} else if(input[i] == "&" || i == il -1){
					if(i == il - 1){
						currentItem += input[i];
					}
					currentObj.push(currentItem);
					currentItem = "";
					if(currentObj.length == 5){
						output.push(currentObj);
					} else {
						console.log("main.js 248: currentObj length is " + currentObj.length, currentObj);
					}
					currentObj = [];
				} else {
					currentItem += input[i];
				}
			}
		}
		return output;
	}
}
process.on('uncaughtException', function (err) {
  console.log('Caught exception: ', err, err.stack);
});
