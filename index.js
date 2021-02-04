const Message = require('@satellite-earth/message');
const createTorrent = require('create-torrent');
const parseTorrent = require('parse-torrent');
const sanitize = require('sanitize-filename');
const ipfsHash = require('ipfs-only-hash');
const sha1 = require('simple-sha1');
const bencode = require('bencode');


class Torrent extends Message {

	constructor (data, options = {}) {

		let input = data;
		let announce = [];

		const parseInfoDict = (info) => {

			const _signed_ = {};
			let size, pieces, pieceLength;

			for (let s of Object.keys(info)) {
				
				const v = info[s];
				let buffer;

				if (s === 'name') {
					buffer = Buffer.from(v, 'utf8');
					_signed_.name = buffer.toString('utf8');
				} else if (s === 'pieces') {
					buffer = Buffer.from(v);
					pieces = buffer.toString('base64');
				} else if (s === 'length') {
					size = parseInt(v);
				} else if (s === 'piece length') {
					pieceLength = parseInt(v);
				}
			}

			// If the piece length explicitly does not match what
			// Satellite would calculate, encode this information
			// in the meta string. This is necessary to support
			// torrents that were not created using Satellite.
			if (pieceLength && pieceLength !== Torrent.inferPieceLength(size)) {
				size = `${size}:${pieceLength}`;
			}

			_signed_.meta = `${size}.${pieces}`;
			return { _params_: {}, _signed_ };
		};

		if ( // If standard torrent info dict
			typeof input === 'object'
			&& typeof input.name !== 'undefined'
			&& typeof input.length !== 'undefined'
			&& typeof input['piece length'] !== 'undefined'
			&& typeof input.pieces !== 'undefined'
		) {

			// Parse the info dict
			input = parseInfoDict(input)

		} else if (Buffer.isBuffer(input)) {

			const parsed = parseTorrent(input);

			// Parse bencoded torrent file
			input = parseInfoDict(parsed.info);
			announce = parsed.announce;
		}

		// Call @earth/message superclass to parse data
		// and get signing and validation functions
		super(input);

		// Save trackers list
		this.announce = announce;

		// Save function to get name if provided
		if (options.deriveName) {
			this.deriveName = options.deriveName;
		}

		// Validate name as it will be used as filename
		if (this.name !== 'untitled' && this.name !== sanitize(this.name)) {
			throw Error('Torrent \'name\' contains illegal chars, is reserved, or is too long. See docs:');
		}
	}

	static inferPieceLength (n) {

		// NOTE: it seems that WebTorrent only works with this piece size—
		// Future versions may adopt WebTorrent's default chunking strategy
		return 16384;
	}

	data (data) {

		return new Promise((resolve, reject) => {

			createTorrent(data, { pieceLength: Torrent.inferPieceLength(data.length || data.size) }, async (err, torrentFile) => {
				if (err) {
					reject(err);
				} else {

					try {
						
						// WebTorrent breaks up the data and sha1s each piece,
						// the hashes are concatenated and converted to base64
						const parsed = parseTorrent(torrentFile);
						const pieces = Buffer.from(parsed.pieces.join(''), 'hex').toString('base64');
						const size = parsed.length;
						let buffer;

						// If in browser, check if data is a blob or file and
						// convert to a buffer so it can be properly hashed
						if (typeof window !== 'undefined' && data instanceof Blob) {

							const bytes = await new Promise(resolve => {
								const fr = new FileReader();
								fr.onload = () => { resolve(fr.result); };
								fr.readAsArrayBuffer(data);
							});

							buffer = Buffer.from(bytes);

						} else {
							buffer = Buffer.from(data);
						}

						// Compute the ipfs multihash of the data as well. Even
						// though Satellite does not use ipfs to distribute
						// data, the goal is to allow other devs to build apps
						// that do. Also, the default hashing algorithm in ipfs
						// is cryptographically much stronger than sha1 (standard
						// in bittorrent), providing an independent check for
						// data integrity if/when an attack on sha1 (specifically
						// a *preimage* attack) becomes computationally feasible.
						const ipfs = await ipfsHash.of(buffer);

						// If torrent already contains signed data params, data being
						// added must match exactly. This is useful for being able
						// to verify some data against an existing torrent message.
						const existingParams = this.dataParams;

						// Ensure that params match any existing
						if (existingParams && this.verified) {
							if (
								existingParams.size !== size
								|| existingParams.ipfs !== ipfs
								|| existingParams.pieces !== pieces
								|| existingParams.pieceLength !== Torrent.inferPieceLength(size)
							) {
								throw Error('Conflicts with existing params. Call clearTorrentParams() to reset torrent data params.');
							}
						}

						// Save data params in signed dict
						this._signed_.meta = `${size}.${pieces}.${ipfs}`;

						// Name not set, fall back to default
						if (typeof this.name === 'undefined') {
							this._signed_.name = 'untitled';
						}
						
						resolve(this); // Allow method chaining

					} catch (parseError) {
						reject(parseError)
					}
				}
			});
		});
	}

	// Removes torrent data params. Since this changes
	// the message payload, reset any existing signature.
	clearTorrentParams () {
		this._signed_.meta = undefined;
		this.clearSig();
	}

	getParsedTorrent (options = {}) { // Parsed torrent file

		const torrentParams = this.torrentParams;
		if (!torrentParams) { return; }
		const { size } = this.dataParams;
		const { infoBuffer, infoHash, info } = torrentParams;

		return { // Object can be passed directly to webtorrent
			length: size,
			info,
			infoHash,
			infoBuffer,
			name: this.name,
			infoHashBuffer: Buffer.from(infoHash, 'hex'),
			announce: options.announce || this.announce,
			urlList: options.urlList || [],
			lastPieceLength: this.lastPieceLength,
			pieceLength: this.pieceLength,
			pieces: this.pieces,
			files: [{
				path: this.name,
				name: this.name,
				offset: 0,
				length: size
			}]
		};
	}

	getTorrentFile (options = {}) { // Bencoded torrent file for download
		const torrent = this.getParsedTorrent(options);
		if (!torrent) { return; }
		return parseTorrent.toTorrentFile(torrent);
	}

	// File name
	get name () {

		if (this.deriveName) {
			return (this.deriveName(this));
		} else if (typeof this._signed_.name !== 'undefined') {
			return this._signed_.name;
		}

		return 'untitled';
	}

	// File extension, if any, based on name
	get extension () {
		if (this.name.indexOf('.') === -1 ) { return; }
		return this.name.slice(this.name.lastIndexOf('.') + 1);
	}

	get length () {
		const dataParams = this.dataParams;
		if (!dataParams) { return; }
		return dataParams.size;
	}

	get pieces () {

		const dataParams = this.dataParams;
		if (!dataParams) { return; }

		// Convert from base64 to hex
		const hex = Buffer.from(dataParams.pieces, 'base64').toString('hex');
		const arr = [];

		// Deconcatenate the sha1 piece hashes
		for (let z = 0; z < hex.length; z += 40) {
			arr.push(hex.substring(z, z + 40));
		}

		return arr;
	}

	get numPieces () {
		return Math.ceil(this.length / this.pieceLength);
	}

	get pieceLength () {
		const dataParams = this.dataParams;
		if (!dataParams) { return; }
		return dataParams.pieceLength;
	}

	get lastPieceLength () {
		const p = this.pieceLength;
		if (!p) { return; }
		return this.length % p || p;
	}

	get info () {
		const name = this.name;
		const dataParams = this.dataParams; 
		return (
			typeof name !== 'undefined'
			&& typeof dataParams !== 'undefined'
		) ? {
			'name': Buffer.from(name, 'utf8'),
			'length': dataParams.size,
			'piece length': this.pieceLength,
			'pieces': Buffer.from(dataParams.pieces, 'base64')
		} : undefined;
	}

	get infoHash () { // The torrent infoHash
		const torrentParams = this.torrentParams;
		if (torrentParams) {
			return torrentParams.infoHash;
		}
	}

	get ipfsHash () { // The ipfs hash of data
		const dataParams = this.dataParams;
		if (!dataParams) { return; }
		return dataParams.ipfs;
	}

	get dataParams () { // Meta data for the file

		if (typeof this._signed_.meta === 'undefined') { return; }
		const s = this._signed_.meta.split('.');
		const native = s[0].indexOf(':') === -1;
		const size = native ? parseInt(s[0]) : parseInt(s[0].split(':')[0]);

		return {
			size,
			pieces: s[1],
			ipfs: s[2],
			pieceLength: native ? Torrent.inferPieceLength(size) : parseInt(s[0].split(':')[1])
		};
	}

	get torrentParams () { // Meta data required to create torrent file
		const info = this.info;
		if (!info) { return; }
		const infoBuffer = bencode.encode(info);
		return {
			infoHash: sha1.sync(infoBuffer),
			infoBuffer,
			info
		};
	}
}

module.exports = Torrent;
