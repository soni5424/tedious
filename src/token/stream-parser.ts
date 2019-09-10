import Debug from '../debug';
import { ConnectionOptions } from '../connection';

const Transform = require('readable-stream').Transform;
const TYPE = require('./token').TYPE;

const tokenParsers: {
  [token: number]: (parser: Parser, colMetadata: any, options: ConnectionOptions, done: (token: Token) => void) => void
} = {};
tokenParsers[TYPE.COLMETADATA] = require('./colmetadata-token-parser');
tokenParsers[TYPE.DONE] = require('./done-token-parser').doneParser;
tokenParsers[TYPE.DONEINPROC] = require('./done-token-parser').doneInProcParser;
tokenParsers[TYPE.DONEPROC] = require('./done-token-parser').doneProcParser;
tokenParsers[TYPE.ENVCHANGE] = require('./env-change-token-parser');
tokenParsers[TYPE.ERROR] = require('./infoerror-token-parser').errorParser;
tokenParsers[TYPE.FEDAUTHINFO] = require('./fedauth-info-parser');
tokenParsers[TYPE.FEATUREEXTACK] = require('./feature-ext-ack-parser');
tokenParsers[TYPE.INFO] = require('./infoerror-token-parser').infoParser;
tokenParsers[TYPE.LOGINACK] = require('./loginack-token-parser');
tokenParsers[TYPE.ORDER] = require('./order-token-parser');
tokenParsers[TYPE.RETURNSTATUS] = require('./returnstatus-token-parser');
tokenParsers[TYPE.RETURNVALUE] = require('./returnvalue-token-parser');
tokenParsers[TYPE.ROW] = require('./row-token-parser');
tokenParsers[TYPE.NBCROW] = require('./nbcrow-token-parser');
tokenParsers[TYPE.SSPI] = require('./sspi-token-parser');

class EndOfMessageMarker {}

type Token = { name: 'COLMETADATA', event: 'columnMetadata', columns: any[] }
           | { name: 'DONE', event: 'done' }
           | { name: 'DONEINPROC', event: 'doneInProc' }
           | { name: 'DONEPROC', event: 'doneProc' }
           | { name: 'ENVCHANGE', type: 'DATABASE', event: 'databaseChange', oldValue: string, newValue: string }
           | { name: 'ENVCHANGE', type: 'LANGUAGE', event: 'languageChange', oldValue: string, newValue: string }
           | { name: 'ENVCHANGE', type: 'CHARSET', event: 'charsetChange', oldValue: string, newValue: string }
           | { name: 'ENVCHANGE', type: 'PACKET_SIZE', event: 'packetSizeChange', oldValue: number, newValue: number }
           | { name: 'ENVCHANGE', type: 'BEGIN_TXN', event: 'beginTransaction', oldValue: Buffer, newValue: Buffer }
           | { name: 'ENVCHANGE', type: 'COMMIT_TXN', event: 'commitTransaction', oldValue: Buffer, newValue: Buffer }
           | { name: 'ENVCHANGE', type: 'ROLLBACK_TXN', event: 'rollbackTransaction', oldValue: Buffer, newValue: Buffer }
           | { name: 'ENVCHANGE', type: 'DATABASE_MIRRORING_PARTNER', event: 'partnerNode', oldValue: string, newValue: string }
           | { name: 'ENVCHANGE', type: 'RESET_CONNECTION', event: 'resetConnection', oldValue: Buffer, newValue: Buffer }
           | { name: 'ENVCHANGE', type: 'ROUTING_CHANGE', event: 'routingChange', oldValue: Buffer, newValue: { protocol: number, port: number, server: string } }
           | { name: 'FEATUREEXTACK', event: 'featureExtAck', fedAuth?: Buffer }
           | { name: 'FEDAUTHINFO', event: 'fedAuthInfo', spn?: string, stsurl?: string }
           | { name: 'INFO', event: 'infoMessage', number: number, state: number, class: number, message: string, serverName: string, procName: string, lineNumber: number }
           | { name: 'ERROR', event: 'errorMessage', number: number, state: number, class: number, message: string, serverName: string, procName: string, lineNumber: number }
           | { name: 'LOGINACK', event: 'loginack', interface: string, tdsVersion: string, progName: string, progVersion: { major: number, minor: number, buildNumHi: number, buildNumLow: number } }
           | { name: 'NBCROW', event: 'row', columns: any[] }
           | { name: 'ORDER', event: 'order', orderColumns: number[] }
           | { name: 'RETURNSTATUS', event: 'returnStatus', value: number }
           | { name: 'RETURNVALUE', event: 'returnValue', paramOrdinal: number, paramName: string, metadata: any, value: unknown }
           | { name: 'ROW', event: 'row', columns: any }
           | { name: 'SSPICHALLENGE', event: 'sspichallenge', ntlmpacket: any, ntlmpacketBuffer: Buffer }
           | { name: 'EOM', event: 'endOfMessage' };

export default class Parser extends Transform {
  debug: Debug;
  colMetadata: any;
  options: ConnectionOptions;
  endOfMessageMarker: EndOfMessageMarker;

  buffer: Buffer;
  position: number;
  suspended: boolean;
  next?: () => void;

  constructor(debug: Debug, colMetadata: any, options: ConnectionOptions) {
    super({ objectMode: true });

    this.debug = debug;
    this.colMetadata = colMetadata;
    this.options = options;
    this.endOfMessageMarker = new EndOfMessageMarker();

    this.buffer = Buffer.alloc(0);
    this.position = 0;
    this.suspended = false;
    this.next = undefined;
  }

  _transform(input: Buffer | EndOfMessageMarker, _encoding: string, done: (error?: Error | null, token?: Token) => void) {
    if (input instanceof EndOfMessageMarker) {
      done(null, { // generate endOfMessage pseudo token
        name: 'EOM',
        event: 'endOfMessage'
      });

      return;
    }

    if (this.position === this.buffer.length) {
      this.buffer = input;
    } else {
      this.buffer = Buffer.concat([this.buffer.slice(this.position), input]);
    }
    this.position = 0;

    if (this.suspended) {
      // Unsuspend and continue from where ever we left off.
      this.suspended = false;
      this.next!.call(null);
    }

    // If we're no longer suspended, parse new tokens
    if (!this.suspended) {
      // Start the parser
      this.parseTokens();
    }

    done();
  }

  parseTokens() {
    const doneParsing = (token: Token) => {
      if (token) {
        switch (token.name) {
          case 'COLMETADATA':
            this.colMetadata = token.columns;
        }

        this.push(token);
      }
    };

    while (!this.suspended && this.position + 1 <= this.buffer.length) {
      const type = this.buffer.readUInt8(this.position);

      this.position += 1;

      if (tokenParsers[type]) {
        tokenParsers[type](this, this.colMetadata, this.options, doneParsing);
      } else {
        this.emit('error', new Error('Unknown type: ' + type));
      }
    }
  }

  suspend(next: () => void) {
    this.suspended = true;
    this.next = next;
  }

  awaitData(length: number, callback: () => void) {
    if (this.position + length <= this.buffer.length) {
      callback();
    } else {
      this.suspend(() => {
        this.awaitData(length, callback);
      });
    }
  }

  readInt8(callback: (data: number) => void) {
    this.awaitData(1, () => {
      const data = this.buffer.readInt8(this.position);
      this.position += 1;
      callback(data);
    });
  }

  readUInt8(callback: (data: number) => void) {
    this.awaitData(1, () => {
      const data = this.buffer.readUInt8(this.position);
      this.position += 1;
      callback(data);
    });
  }

  readInt16LE(callback: (data: number) => void) {
    this.awaitData(2, () => {
      const data = this.buffer.readInt16LE(this.position);
      this.position += 2;
      callback(data);
    });
  }

  readInt16BE(callback: (data: number) => void) {
    this.awaitData(2, () => {
      const data = this.buffer.readInt16BE(this.position);
      this.position += 2;
      callback(data);
    });
  }

  readUInt16LE(callback: (data: number) => void) {
    this.awaitData(2, () => {
      const data = this.buffer.readUInt16LE(this.position);
      this.position += 2;
      callback(data);
    });
  }

  readUInt16BE(callback: (data: number) => void) {
    this.awaitData(2, () => {
      const data = this.buffer.readUInt16BE(this.position);
      this.position += 2;
      callback(data);
    });
  }

  readInt32LE(callback: (data: number) => void) {
    this.awaitData(4, () => {
      const data = this.buffer.readInt32LE(this.position);
      this.position += 4;
      callback(data);
    });
  }

  readInt32BE(callback: (data: number) => void) {
    this.awaitData(4, () => {
      const data = this.buffer.readInt32BE(this.position);
      this.position += 4;
      callback(data);
    });
  }

  readUInt32LE(callback: (data: number) => void) {
    this.awaitData(4, () => {
      const data = this.buffer.readUInt32LE(this.position);
      this.position += 4;
      callback(data);
    });
  }

  readUInt32BE(callback: (data: number) => void) {
    this.awaitData(4, () => {
      const data = this.buffer.readUInt32BE(this.position);
      this.position += 4;
      callback(data);
    });
  }

  readInt64LE(callback: (data: number) => void) {
    this.awaitData(8, () => {
      const data = Math.pow(2, 32) * this.buffer.readInt32LE(this.position + 4) + ((this.buffer[this.position + 4] & 0x80) === 0x80 ? 1 : -1) * this.buffer.readUInt32LE(this.position);
      this.position += 8;
      callback(data);
    });
  }

  readInt64BE(callback: (data: number) => void) {
    this.awaitData(8, () => {
      const data = Math.pow(2, 32) * this.buffer.readInt32BE(this.position) + ((this.buffer[this.position] & 0x80) === 0x80 ? 1 : -1) * this.buffer.readUInt32BE(this.position + 4);
      this.position += 8;
      callback(data);
    });
  }

  readUInt64LE(callback: (data: number) => void) {
    this.awaitData(8, () => {
      const data = Math.pow(2, 32) * this.buffer.readUInt32LE(this.position + 4) + this.buffer.readUInt32LE(this.position);
      this.position += 8;
      callback(data);
    });
  }

  readUInt64BE(callback: (data: number) => void) {
    this.awaitData(8, () => {
      const data = Math.pow(2, 32) * this.buffer.readUInt32BE(this.position) + this.buffer.readUInt32BE(this.position + 4);
      this.position += 8;
      callback(data);
    });
  }

  readFloatLE(callback: (data: number) => void) {
    this.awaitData(4, () => {
      const data = this.buffer.readFloatLE(this.position);
      this.position += 4;
      callback(data);
    });
  }

  readFloatBE(callback: (data: number) => void) {
    this.awaitData(4, () => {
      const data = this.buffer.readFloatBE(this.position);
      this.position += 4;
      callback(data);
    });
  }

  readDoubleLE(callback: (data: number) => void) {
    this.awaitData(8, () => {
      const data = this.buffer.readDoubleLE(this.position);
      this.position += 8;
      callback(data);
    });
  }

  readDoubleBE(callback: (data: number) => void) {
    this.awaitData(8, () => {
      const data = this.buffer.readDoubleBE(this.position);
      this.position += 8;
      callback(data);
    });
  }

  readUInt24LE(callback: (data: number) => void) {
    this.awaitData(3, () => {
      const low = this.buffer.readUInt16LE(this.position);
      const high = this.buffer.readUInt8(this.position + 2);

      this.position += 3;

      callback(low | (high << 16));
    });
  }

  readUInt40LE(callback: (data: number) => void) {
    this.awaitData(5, () => {
      const low = this.buffer.readUInt32LE(this.position);
      const high = this.buffer.readUInt8(this.position + 4);

      this.position += 5;

      callback((0x100000000 * high) + low);
    });
  }

  readUNumeric64LE(callback: (data: number) => void) {
    this.awaitData(8, () => {
      const low = this.buffer.readUInt32LE(this.position);
      const high = this.buffer.readUInt32LE(this.position + 4);

      this.position += 8;

      callback((0x100000000 * high) + low);
    });
  }

  readUNumeric96LE(callback: (data: number) => void) {
    this.awaitData(12, () => {
      const dword1 = this.buffer.readUInt32LE(this.position);
      const dword2 = this.buffer.readUInt32LE(this.position + 4);
      const dword3 = this.buffer.readUInt32LE(this.position + 8);

      this.position += 12;

      callback(dword1 + (0x100000000 * dword2) + (0x100000000 * 0x100000000 * dword3));
    });
  }

  readUNumeric128LE(callback: (data: number) => void) {
    this.awaitData(16, () => {
      const dword1 = this.buffer.readUInt32LE(this.position);
      const dword2 = this.buffer.readUInt32LE(this.position + 4);
      const dword3 = this.buffer.readUInt32LE(this.position + 8);
      const dword4 = this.buffer.readUInt32LE(this.position + 12);

      this.position += 16;

      callback(dword1 + (0x100000000 * dword2) + (0x100000000 * 0x100000000 * dword3) + (0x100000000 * 0x100000000 * 0x100000000 * dword4));
    });
  }

  // Variable length data

  readBuffer(length: number, callback: (data: Buffer) => void) {
    this.awaitData(length, () => {
      const data = this.buffer.slice(this.position, this.position + length);
      this.position += length;
      callback(data);
    });
  }

  // Read a Unicode String (BVARCHAR)
  readBVarChar(callback: (data: string) => void) {
    this.readUInt8((length) => {
      this.readBuffer(length * 2, (data) => {
        callback(data.toString('ucs2'));
      });
    });
  }

  // Read a Unicode String (USVARCHAR)
  readUsVarChar(callback: (data: string) => void) {
    this.readUInt16LE((length) => {
      this.readBuffer(length * 2, (data) => {
        callback(data.toString('ucs2'));
      });
    });
  }

  // Read binary data (BVARBYTE)
  readBVarByte(callback: (data: Buffer) => void) {
    this.readUInt8((length) => {
      this.readBuffer(length, callback);
    });
  }

  // Read binary data (USVARBYTE)
  readUsVarByte(callback: (data: Buffer) => void) {
    this.readUInt16LE((length) => {
      this.readBuffer(length, callback);
    });
  }
}