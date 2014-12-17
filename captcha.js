var gm = require('gm');
var fs = require('fs');
var pool = [];
var main = module.parent.exports;
var ipLockout = {};

main.on("getCaptcha", function(conn, data){
	var challenge = Math.random().toString().substr(2);
	var captchaText = Math.round(100000 + Math.random() * 899999);
	pool[challenge] = captchaText;
	if(conn.upgradeReq.headers['x-forwarded-for']){
		if(!ipLockout[conn.upgradeReq.headers['x-forwarded-for']]){
			ipLockout[conn.upgradeReq.headers['x-forwarded-for']] = [1, new Date().getTime()];
		} else {
			if(ipLockout[conn.upgradeReq.headers['x-forwarded-for']][1] > new Date().getTime() - 15 * 1000){
				ipLockout[conn.upgradeReq.headers['x-forwarded-for']][0]++;
				ipLockout[conn.upgradeReq.headers['x-forwarded-for']][1] = new Date().getTime();
			} else {
				ipLockout[conn.upgradeReq.headers['x-forwarded-for']] = [1, new Date().getTime()];
			}
		}
		if(ipLockout[conn.upgradeReq.headers['x-forwarded-for']] > 6){
			captchaText = "TOOMANY";
		}
	}
	
	var captchaImg = gm(220, 80, "#ffffff");
	
	captchaImg.stroke("#000000", 2).fill("#ffffff");
	
	for(var i = 0; i < 6; i++){
		var x = Math.random()*220;
		var y = Math.random()*80;
		captchaImg.drawCircle(x, y, x, y+10+Math.random()*30);
	}
	
	
	captchaImg.stroke("#000000", 1).fontSize(22+Math.floor(Math.random()*7)).fill("#000000").draw("translate 0, 0 rotate " + Math.round((-10+Math.random()*20)) + " text " + (25+Math.random()*75) + " " + (30+Math.random()*35) + "\"" + captchaText + "\"");
	
	
	captchaImg.quality(35).write("./tmp/captcha-" + challenge + ".jpg", function(err){
		if(err){
			console.log("Write captcha error " + err);
			return;
		}
		fs.readFile("./tmp/captcha-" + challenge + ".jpg", function(err, filedata){
			if(err){
				console.log("Read file error while reading CAPTCHA " + err);
				return;
			}
			conn.msg("captcha", {purpose: data.purpose, captcha: "data:image/jpeg;base64," + filedata.toString("base64"), challenge: challenge});
			fs.unlink("./tmp/captcha-" + challenge + ".jpg");
		});
	});
	
	setTimeout(function(){
		delete pool[challenge];
	}, 20 * 60 * 1000);	
});

module.exports.checkCaptcha = function(challenge, answer){
	if(pool[challenge]){
		if(pool[challenge] === parseInt(answer)){
			delete pool[challenge];
			return true;
		}
		delete pool[challenge];
	}
	return false;
}
