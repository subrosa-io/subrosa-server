SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";
CREATE DATABASE IF NOT EXISTS `subrosa` DEFAULT CHARACTER SET latin1 COLLATE latin1_swedish_ci;
USE `subrosa`;

CREATE TABLE IF NOT EXISTS `avatars` (
  `uid` varchar(20) NOT NULL,
  `avatar` longblob NOT NULL,
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `time` (`time`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE IF NOT EXISTS `conv` (
  `id` varchar(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `blobbuffer` mediumblob NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE IF NOT EXISTS `users` (
  `uid` char(16) NOT NULL,
  `username` varchar(16) NOT NULL,
  `displayname` varchar(30) CHARACTER SET utf16 COLLATE utf16_bin NOT NULL,
  `email` varchar(100) NOT NULL,
  `newsletter` int(1) NOT NULL,
  `passwordhash` char(64) NOT NULL,
  `publicKey` varchar(2000) NOT NULL,
  `ivBin` binary(16) NOT NULL,
  `saltBin` binary(32) NOT NULL,
  `kdf` char(3) NOT NULL,
  `userblob` longtext CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `lastaccess` datetime NOT NULL,
  PRIMARY KEY (`uid`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

