/**
 * Builds src/renderer/src/vendor/jsmpeg/jsmpeg.js from jsmpeg's readable
 * sources (phoboslab/jsmpeg, MIT, commit 924acfbd; fetch src/jsmpeg.js,
 * buffer.js, decoder.js, mpeg1.js, webgl.js and canvas2d.js into a folder):
 *
 *   node scripts/build-jsmpeg.cjs <folder with jsmpeg's src files>
 *
 * Only what the movie player needs, as one ES module, with two changes FFXI's
 * opening movie needs (both recorded below and in vendor/jsmpeg/README.md):
 *
 * 1. End of slice: a slice ends where the next 23 bits are zero (MPEG-1's
 *    own rule). jsmpeg only looked for 00 00 01 at the next byte, and this
 *    encoder pads zero bytes before start codes, so it read past every slice
 *    end: the first slice of a keyframe ran 159 macroblocks instead of 32.
 * 2. B-pictures: jsmpeg skipped them (its README says so); two thirds of the
 *    movie's pictures are B. Added: backward vectors (full_pel_backward,
 *    backward_f_code), a third picture buffer (the older anchor), forward,
 *    backward and averaged prediction with half-pel interpolation, skipped
 *    B macroblocks repeating the previous one's prediction, and display
 *    order (an anchor is shown when the next anchor arrives; a B at once).
 *    Leading B-pictures before a decoder has two anchors (after a seek into
 *    an open GOP) are skipped.
 */
const fs = require('fs')
const path = require('path')

const src = process.argv[2]
if (!src) { console.error('usage: node scripts/build-jsmpeg.cjs <jsmpeg src folder>'); process.exit(1) }
const read = f => fs.readFileSync(path.join(src, f), 'utf8').replace(/\r\n/g, '\n')
// Matches \`from\` with any run of whitespace standing for any other (the
// sources mix tabs, spaces and trailing blanks).
const patch = (text, from, to, what) => {
  const re = new RegExp(from.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'))
  if (!re.test(text)) throw new Error('patch did not apply: ' + what)
  return text.replace(re, () => to)
}

let buffer = read('buffer.js')
buffer = patch(buffer, `BitBuffer.prototype.nextBytesAreStartCode = function() {
	var i = (this.index+7 >> 3);
	return (
		i >= this.byteLength || (
			this.bytes[i] == 0x00 &&
			this.bytes[i+1] == 0x00 &&
			this.bytes[i+2] == 0x01
		)
	);
};`, `BitBuffer.prototype.nextBytesAreStartCode = function() {
	// FFXI Explorer: MPEG-1's rule, the next 23 bits are zero. Zero bytes may
	// pad before a start code, which the byte test missed.
	if ((this.index >> 3) >= this.byteLength) {
		return true;
	}
	return this.peek(23) === 0;
};`, 'slice end')

let mpeg = read('mpeg1.js')
mpeg = patch(mpeg, `	this.forwardCb = new Uint8ClampedArray(this.codedSize >> 2);
	this.forwardCb32 = new Uint32Array(this.forwardCb.buffer);
};`, `	this.forwardCb = new Uint8ClampedArray(this.codedSize >> 2);
	this.forwardCb32 = new Uint32Array(this.forwardCb.buffer);

	// FFXI Explorer: the older anchor, B-pictures' forward reference.
	this.olderY = new Uint8ClampedArray(this.codedSize);
	this.olderY32 = new Uint32Array(this.olderY.buffer);
	this.olderCr = new Uint8ClampedArray(this.codedSize >> 2);
	this.olderCr32 = new Uint32Array(this.olderCr.buffer);
	this.olderCb = new Uint8ClampedArray(this.codedSize >> 2);
	this.olderCb32 = new Uint32Array(this.olderCb.buffer);
	this.anchorsSeen = 0;
};`, 'third buffer')

mpeg = patch(mpeg, `	// Skip B and D frames or unknown coding type
	if (this.pictureType <= 0 || this.pictureType >= MPEG1.PICTURE_TYPE.B) {
		return;
	}

	// full_pel_forward, forward_f_code
	if (this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE) {`, `	// Skip D frames or unknown coding type
	if (this.pictureType <= 0 || this.pictureType > MPEG1.PICTURE_TYPE.B) {
		return;
	}
	// FFXI Explorer: a B-picture needs both its anchors.
	if (this.pictureType === MPEG1.PICTURE_TYPE.B && this.anchorsSeen < 2) {
		return;
	}

	// full_pel_forward, forward_f_code
	if (this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE || this.pictureType === MPEG1.PICTURE_TYPE.B) {`, 'picture types')

mpeg = patch(mpeg, `		this.forwardRSize = this.forwardFCode - 1;
		this.forwardF = 1 << this.forwardRSize;
	}
`, `		this.forwardRSize = this.forwardFCode - 1;
		this.forwardF = 1 << this.forwardRSize;
	}
	if (this.pictureType === MPEG1.PICTURE_TYPE.B) {
		this.fullPelBackward = this.bits.read(1);
		this.backwardFCode = this.bits.read(3);
		if (this.backwardFCode === 0) {
			return;
		}
		this.backwardRSize = this.backwardFCode - 1;
		this.backwardF = 1 << this.backwardRSize;
	}
`, 'backward f code')

mpeg = patch(mpeg, `	// Invoke decode callbacks
	if (this.destination) {
		this.destination.render(this.currentY, this.currentCr, this.currentCb, true);
	}

	// If this is a reference picutre then rotate the prediction pointers
	if (
		this.pictureType === MPEG1.PICTURE_TYPE.INTRA ||
		this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE
	) {
		var
			tmpY = this.forwardY,
			tmpY32 = this.forwardY32,
			tmpCr = this.forwardCr,
			tmpCr32 = this.forwardCr32,
			tmpCb = this.forwardCb,
			tmpCb32 = this.forwardCb32;

		this.forwardY = this.currentY;
		this.forwardY32 = this.currentY32;
		this.forwardCr = this.currentCr;
		this.forwardCr32 = this.currentCr32;
		this.forwardCb = this.currentCb;
		this.forwardCb32 = this.currentCb32;

		this.currentY = tmpY;
		this.currentY32 = tmpY32;
		this.currentCr = tmpCr;
		this.currentCr32 = tmpCr32;
		this.currentCb = tmpCb;
		this.currentCb32 = tmpCb32;
	}
};`, `	// FFXI Explorer: display order. A B-picture shows at once; an anchor
	// rotates the references (older <- newest <- this) and shows the anchor
	// before it, whose B-pictures have now all been shown.
	if (this.pictureType === MPEG1.PICTURE_TYPE.B) {
		if (this.destination) {
			this.destination.render(this.currentY, this.currentCr, this.currentCb, true);
		}
		return;
	}
	var
		tmpY = this.olderY, tmpY32 = this.olderY32,
		tmpCr = this.olderCr, tmpCr32 = this.olderCr32,
		tmpCb = this.olderCb, tmpCb32 = this.olderCb32;

	this.olderY = this.forwardY; this.olderY32 = this.forwardY32;
	this.olderCr = this.forwardCr; this.olderCr32 = this.forwardCr32;
	this.olderCb = this.forwardCb; this.olderCb32 = this.forwardCb32;

	this.forwardY = this.currentY; this.forwardY32 = this.currentY32;
	this.forwardCr = this.currentCr; this.forwardCr32 = this.currentCr32;
	this.forwardCb = this.currentCb; this.forwardCb32 = this.currentCb32;

	this.currentY = tmpY; this.currentY32 = tmpY32;
	this.currentCr = tmpCr; this.currentCr32 = tmpCr32;
	this.currentCb = tmpCb; this.currentCb32 = tmpCb32;

	this.anchorsSeen++;
	if (this.anchorsSeen >= 2 && this.destination) {
		this.destination.render(this.olderY, this.olderCr, this.olderCb, true);
	}
};`, 'display order')

mpeg = patch(mpeg, `	// Reset motion vectors and DC predictors
	this.motionFwH = this.motionFwHPrev = 0;
	this.motionFwV = this.motionFwVPrev = 0;`, `	// Reset motion vectors and DC predictors
	this.motionFwH = this.motionFwHPrev = 0;
	this.motionFwV = this.motionFwVPrev = 0;
	this.motionBwH = this.motionBwHPrev = 0;
	this.motionBwV = this.motionBwVPrev = 0;`, 'slice vector reset')

mpeg = patch(mpeg, `		// Predict skipped macroblocks
		while (increment > 1) {
			this.macroblockAddress++;
			this.mbRow = (this.macroblockAddress / this.mbWidth)|0;
			this.mbCol = this.macroblockAddress % this.mbWidth;
			this.copyMacroblock(
				this.motionFwH, this.motionFwV,
				this.forwardY, this.forwardCr, this.forwardCb
			);
			increment--;
		}`, `		// Predict skipped macroblocks (in a B-picture, as the previous one was)
		while (increment > 1) {
			this.macroblockAddress++;
			this.mbRow = (this.macroblockAddress / this.mbWidth)|0;
			this.mbCol = this.macroblockAddress % this.mbWidth;
			this.predictMacroblock();
			increment--;
		}`, 'skipped prediction')

mpeg = patch(mpeg, `	this.macroblockMotFw = (this.macroblockType & 0x08);`, `	this.macroblockMotFw = (this.macroblockType & 0x08);
	this.macroblockMotBw = (this.macroblockType & 0x04);`, 'backward flag')

mpeg = patch(mpeg, `		// Intra-coded macroblocks reset motion vectors
		this.motionFwH = this.motionFwHPrev = 0;
		this.motionFwV = this.motionFwVPrev = 0;
	}`, `		// Intra-coded macroblocks reset motion vectors
		this.motionFwH = this.motionFwHPrev = 0;
		this.motionFwV = this.motionFwVPrev = 0;
		this.motionBwH = this.motionBwHPrev = 0;
		this.motionBwV = this.motionBwVPrev = 0;
	}`, 'intra vector reset')

mpeg = patch(mpeg, `		this.decodeMotionVectors();
		this.copyMacroblock(
			this.motionFwH, this.motionFwV,
			this.forwardY, this.forwardCr, this.forwardCb
		);`, `		this.decodeMotionVectors();
		this.predictMacroblock();`, 'macroblock prediction')

mpeg = patch(mpeg, `	else if (this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE) {
		// No motion information in P-picture, reset vectors
		this.motionFwH = this.motionFwHPrev = 0;
		this.motionFwV = this.motionFwVPrev = 0;
	}
};`, `	else if (this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE) {
		// No motion information in P-picture, reset vectors
		this.motionFwH = this.motionFwHPrev = 0;
		this.motionFwV = this.motionFwVPrev = 0;
	}

	// FFXI Explorer: backward vectors (B-pictures), decoded like the forward ones.
	if (this.macroblockMotBw) {
		this.motionBwHPrev = this.decodeVector(this.motionBwHPrev, this.backwardF, this.backwardRSize);
		this.motionBwH = this.fullPelBackward ? this.motionBwHPrev << 1 : this.motionBwHPrev;
		this.motionBwVPrev = this.decodeVector(this.motionBwVPrev, this.backwardF, this.backwardRSize);
		this.motionBwV = this.fullPelBackward ? this.motionBwVPrev << 1 : this.motionBwVPrev;
	}
};

// FFXI Explorer: one motion vector component, from its predictor.
MPEG1.prototype.decodeVector = function(prev, f, rSize) {
	var code = this.readHuffman(MPEG1.MOTION), d, r;
	if ((code !== 0) && (f !== 1)) {
		r = this.bits.read(rSize);
		d = ((Math.abs(code) - 1) << rSize) + r + 1;
		if (code < 0) {
			d = -d;
		}
	}
	else {
		d = code;
	}
	prev += d;
	if (prev > (f << 4) - 1) {
		prev -= f << 5;
	}
	else if (prev < ((-f) << 4)) {
		prev += f << 5;
	}
	return prev;
};

// FFXI Explorer: the macroblock's prediction. P: from the newest anchor.
// B: forward from the older anchor, backward from the newest, or both averaged.
MPEG1.prototype.predictMacroblock = function() {
	if (this.pictureType !== MPEG1.PICTURE_TYPE.B) {
		this.copyMacroblock(this.motionFwH, this.motionFwV, this.forwardY, this.forwardCr, this.forwardCb);
		return;
	}
	if (this.macroblockMotFw) {
		this.copyMacroblock(this.motionFwH, this.motionFwV, this.olderY, this.olderCr, this.olderCb);
		if (this.macroblockMotBw) {
			this.averageMacroblock(this.motionBwH, this.motionBwV, this.forwardY, this.forwardCr, this.forwardCb);
		}
	}
	else {
		this.copyMacroblock(this.motionBwH, this.motionBwV, this.forwardY, this.forwardCr, this.forwardCb);
	}
};

// FFXI Explorer: averages a second (backward) prediction into the current macroblock.
MPEG1.prototype.averageMacroblock = function(motionH, motionV, sY, sCr, sCb) {
	this.averagePlane(this.currentY, sY, this.codedWidth, 16, this.mbCol << 4, this.mbRow << 4, motionH, motionV);
	// Chroma vectors: half, truncated toward zero, as copyMacroblock takes them.
	var cH = (motionH / 2) | 0, cV = (motionV / 2) | 0;
	this.averagePlane(this.currentCr, sCr, this.halfWidth, 8, this.mbCol << 3, this.mbRow << 3, cH, cV);
	this.averagePlane(this.currentCb, sCb, this.halfWidth, 8, this.mbCol << 3, this.mbRow << 3, cH, cV);
};

MPEG1.prototype.averagePlane = function(d, s, width, size, x0, y0, mH, mV) {
	var H = mH >> 1, V = mV >> 1, oddH = mH & 1, oddV = mV & 1;
	for (var y = 0; y < size; y++) {
		var src = (y0 + y + V) * width + x0 + H, dst = (y0 + y) * width + x0;
		for (var x = 0; x < size; x++, src++, dst++) {
			var p;
			if (oddH && oddV) { p = (s[src] + s[src + 1] + s[src + width] + s[src + width + 1] + 2) >> 2; }
			else if (oddH) { p = (s[src] + s[src + 1] + 1) >> 1; }
			else if (oddV) { p = (s[src] + s[src + width] + 1) >> 1; }
			else { p = s[src]; }
			d[dst] = (d[dst] + p + 1) >> 1;
		}
	}
};`, 'backward vectors and prediction')

// No players or <div class="jsmpeg"> elements here, so no scan for them.
const ns = patch(read('jsmpeg.js'), `// Automatically create players for all found <div class="jsmpeg"/> elements.
if (document.readyState === 'complete') {
	JSMpeg.CreateVideoElements();
}
else {
	document.addEventListener('DOMContentLoaded', JSMpeg.CreateVideoElements);
}`, '', 'no auto players')

const parts = [ns, buffer, read('decoder.js'), mpeg, read('webgl.js'), read('canvas2d.js')]
const out = `/*! jsmpeg v1.0 | (c) Dominic Szablewski | MIT license
 * Built by scripts/build-jsmpeg.cjs from jsmpeg's src/ at commit 924acfbd,
 * with FFXI Explorer's changes marked "FFXI Explorer" (slice ends, B-pictures).
 */
${parts.join('\n\n')}

export default JSMpeg
`
const target = path.join(__dirname, '..', 'src', 'renderer', 'src', 'vendor', 'jsmpeg', 'jsmpeg.js')
fs.writeFileSync(target, out)
console.log('wrote', target, out.length, 'bytes')
