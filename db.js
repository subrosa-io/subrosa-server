var mysql = require('mysql2');
var config = require("./config.js");

var sql = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    socketPath: '/var/run/mysqld/mysqld.sock',
    database: config.db.database,
    connectionLimit: 50,
    multipleStatements: true,
    trace: false
});

var noderedis = require('redis');
var redis = noderedis.createClient();

redis.on("error", function (err) {
	console.log("Redis Error " + err);
});

function sqlQuery(query, response){
    sql.getConnection(function(err, connection) {
		if(err){
			console.log(err);
		}
        connection.query(query, function(err, rows){
            if(response){
                response.apply(this, arguments);
            }
            connection.release();
        });;
    });
}

module.exports.sql = sql;
module.exports.sqlQuery = sqlQuery;
module.exports.escape = mysql.escape;
module.exports.redis = redis;
