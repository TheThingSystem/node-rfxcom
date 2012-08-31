var _ = require("underscore"),
  serialport = require("serialport"),
  EventEmitter = require("events").EventEmitter,
  util = require("util");

function RfxCom(device, options) {
  var self = this;
  this.options = options || {};

  this.handlers = {
    0x01: "interfaceHandler",
    0x02: "messageHandler",
    0x14: "lighting5Handler",
    0x5a: "elec2Handler",
    0x20: "security1Handler"
  }

  // Running counter for command numbers.
  this._cmd = 0;
  this.device = device;

  // This is a buffering parser which accumulates bytes until it receives the
  // number of bytes specified in the first byte of the message.
  // It relies on a flushed buffer, to ensure the first byte corresponds to the
  // size of the first message.
  // The 'data' message emitted has all the bytes from the message.
  this.rfxtrxParser = function() {
    var data = [],
        requiredBytes = 0;
    return function (emitter, buffer) {
      // Collect data
      data.push.apply(data, buffer);
      if (requiredBytes==0) {
        requiredBytes = buffer[0] + 1;
      }
      if (data.length>=requiredBytes) {
        emitter.emit("data", data.slice(0, requiredBytes+1));
        data = data.slice(requiredBytes);
        requiredBytes = 0;
      }
    };
  }
};

util.inherits(RfxCom, EventEmitter);

RfxCom.prototype.open = function() {
  var self = this;
  this.serial = new serialport.SerialPort(this.device, {
    baudrate : 38400,
    parser: this.rfxtrxParser()
  });

  this.serial.on("open", function() {
    self.emit("ready");
  });

  // Add data read event listener
  this.serial.on("data", function(data) {
    if (self.options.debug) {
      console.log("Received: %s", self.dumpHex(data));
    }
    var length = data.shift(),
       packet_type = data.shift();
       handler = self.handlers[packet_type];
    if (typeof handler != "undefined") {
      self[handler](data);
    } else {
      if (self.options.debug) {
        console.log("Unhandled packet type = %s", self.dumpHex([packet_type]));
      }
    }
  });

  this.serial.on("error", function(msg) {
    console.log("Error %s", msg);
  });

  this.serial.on("end", function() {
    console.log("Received 'end'");
  });

  this.serial.on("drain", function() {
    console.log("Received 'drain'");
  });
}

RfxCom.prototype.messageHandler = function(data) {
  var subtype = data[0]
    , seqnbr = data[1]
    , responses = {
        0: "ACK - transmit OK",
        1: "ACK - transmit delayed",
        2: "NAK - transmitter did not lock onto frequency",
        3: "NAK - AC address not allowed"
      }
    , message = data[2];
  this.emit("response", responses[message], seqnbr);
}

/**
 *
 * Called by the data event handler when data arrives from the device with
 * information about its settings.
 *
 */
RfxCom.prototype.interfaceHandler = function(data) {
  var receiver_types = {
    0x50: "310MHz",
    0x51: "315MHz",
    0x52: "433.92MHz receiver only",
    0x53: "433.92MHz transceiver",
    0x55: "868.00MHz",
    0x56: "868.00MHz FSK",
    0x57: "868.30MHz",
    0x58: "868.30MHz FSK",
    0x59: "868.35MHz",
    0x5A: "868.35MHz FSK",
    0x5B: "868.95MHz"
  };

  var subtype = data[0],
      seqnbr = data[1],
      cmnd = data[2],
      receiver_type = receiver_types[data[3]],
      firmware_version = data[4];
  this.emit("status", subtype, seqnbr, cmnd, receiver_type, firmware_version);
}

/**
 *
 * Called by the data event handler when data arrives from a LightwaveRF/Siemens
 * light control device.
 *
 */
RfxCom.prototype.lighting5Handler = function(data) {
  var subtypes = {
        0x00: "LightwaveRF, Siemens",
        0x01: "EMW100 GAO/Everflourish"
      },
      commands = {
        0x00: "Off",
        0x01: "On"
      },
      subtype = subtypes[data[0]],
      seqnbr = data[1],
      id = "0x" + this.dumpHex(data.slice(2, 5), false).join(""),
      unitcode = data[5],
      command = commands[data[6]];

  this.emit("lighting5", subtype, id, unitcode, command);
}

/**
 *
 * Fetches a "command number" sequence number for identifying requests sent to
 * the device.
 *
 */
RfxCom.prototype.getCmdNumber = function() {
  if (this._cmd > 256)
    this._cmd = 0;
  return this._cmd++;
}

/**
 *
 * Writes the reset sequence to the RFxtrx433.
 *
 */
RfxCom.prototype.reset = function(callback) {
  var buffer = [13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  this.serial.write(buffer, callback);
}

/**
 *
 * Calls flush on the underlying SerialPort.
 *
 */
RfxCom.prototype.flush = function(callback) {
  this.serial.flush(callback);
}

RfxCom.prototype.getStatus = function(callback) {
  var cmd_id = this.getCmdNumber(),
      buffer = [13, 0, 0, cmd_id, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  this.serial.write(buffer, function(err, response) {
    if (callback) {
      return callback(err, response, cmd_id);
    }
  });
  return cmd_id;
}

/**
 *
 * Turn on the specified light unit.
 *
 * Currently only works for lighting5 (LightwaveRF, Siemens) lights.
 *
 */
RfxCom.prototype.lightOn = function(id, unit, callback) {
  var self = this
    , cmd_id = this.getCmdNumber()
    ,  id_bytes = this.stringToBytes(id)
    ,  buffer = [0x0A, 0x14, 0, cmd_id, id_bytes[0], id_bytes[1], id_bytes[2], unit, 1, 0, 0];

  if (self.options.debug) {
    console.log("Sending lightOn data: %s", self.dumpHex(buffer));
  }
  this.serial.write(buffer, function(err, response) {
    callback(err, response, cmd_id);
  });
  return cmd_id;
}

/**
 *
 * Turn off the specified light unit.
 *
 * Currently only works for lighting5 (LightwaveRF, Siemens) lights.
 *
 */
RfxCom.prototype.lightOff = function(id, unit, callback) {
  var self = this
    , cmd_id = this.getCmdNumber()
    , id_bytes = this.stringToBytes(id)
    , buffer = [0x0A, 0x14, 0, cmd_id, id_bytes[0], id_bytes[1], id_bytes[2], unit, 0, 0, 0];

  if (self.options.debug) {
    console.log("Sending lightOff data: %s", self.dumpHex(buffer));
  }
  this.serial.write(buffer, function(err, response) {
    callback(err, response, cmd_id);
  });
  return cmd_id;
}

/**
 *
 * Wait for at least the specified number of milliseconds.
 *
 * This may not wait precisely for that number of milliseconds due to the
 * vagaries of system scheduling, but no fewer than the specified ms.
 *
 */
RfxCom.prototype.delay = function(ms) {
  ms += +new Date();
  while (+new Date() < ms) { }
}

RfxCom.prototype.dumpHex = function(buffer, prefix) {
  var prefix = prefix ? prefix : "";
  function dec2hex(value) {
    var hexDigits = "0123456789ABCDEF";
    return prefix + (hexDigits[value >> 4] + hexDigits[value & 15]); 
  };
  return _.map(buffer, dec2hex)
}

/**
 *
 * Converts an array of 4 bytes to a 32bit integer.
 *
 */
RfxCom.prototype.bytesToUint32 = function(bytes) {
  return (bytes[0] * Math.pow(2, 24)) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
};

/**
 *
 * Converts an array of 6 bytes to a 48bit integer.
 *
 */
RfxCom.prototype.bytesToUint48 = function(bytes) {
  return (bytes[0] * Math.pow(2, 40)) + (bytes[1] * Math.pow(2, 32)) +
    (bytes[2] * Math.pow(2, 24)) + (bytes[3] << 16) + (bytes[4] << 8) + bytes[4]
}

/**
 *
 * Converts a string to an array of Byte values.
 *
 * e.g. stringToBytes("202020") == [32, 32, 32]
 *
 */
RfxCom.prototype.stringToBytes = function(bytes) {
  var result = [];
  for (var i=0; i < bytes.length; i+=2) {
    var byteString = bytes.substr(i, 2);
    if (byteString != "0x") {
      var value = parseInt(bytes.substr(i, 2), 16);
      if (typeof value != "undefined") {
        result.push(value);
      }
    }
  }
  return result;
}

/**
 *
 * Called by the data event handler when data arrives an OWL CM119/CM160 power
 * measurement device.
 *
 * Calculates the current usage and total usage from the bytes sent, and emits
 * an "elec2" message for handling.
 *
 */
RfxCom.prototype.elec2Handler = function(data) {
  var subtypes = {
        0x01: "CM119/160"
      },
      TOTAL_DIVISOR = 223.666,
      subtype = subtypes[data[0]],
      seqnbr = data[1],
      id = "0x" + this.dumpHex(data.slice(2, 4), false).join(""),
      count = data[4],
      instant = data.slice(5, 9),
      total = data.slice(9, 15),
      current_watts = this.bytesToUint32(instant),
      total_watts = this.bytesToUint48(total) / TOTAL_DIVISOR;

  var rounded_total = Math.round(total_watts * Math.pow(10, 2)) / Math.pow(10, 2);

  this.emit("elec2", subtype, id, current_watts, rounded_total);
}

/**
 *
 * Called by the data event handler when data arrives from various security
 * devices.
 *
 */
RfxCom.prototype.security1Handler = function(data) {
  var subtypes = {
        0x00: "X10 Securityy door/windo sensor",
        0x01: "X10 security motion sensor",
        0x02: "X10 security remote (no alive packets)",
      },
      subtype = subtypes[data[0]],
      seqnbr = data[1],
      id = "0x" + this.dumpHex(data.slice(2, 5), false).join(""),
      device_status = data[5],
      battery_level = data[6];

  this.emit("security1", subtype, id, device_status, battery_level);
}


RfxCom.prototype.resetTamper = function(callback) {
  var cmd_id = this.getCmdNumber(),
      // 08,20,01,01,F3,FC,6F,84,89
      buffer = [0x08, 0x20, 0x01, cmd_id, 0xF3, 0xFC, 0x6F, 0x84 & 0x7f, 0x00];
  this.serial.write(buffer, function(err, response) {
    if (callback) {
      return callback(err, response, cmd_id);
    }
  });
  return cmd_id;
}

module.exports.RfxCom = RfxCom;