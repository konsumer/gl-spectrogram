(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Lightweight canvas version of a spectrogram.
 * @module gl-spectrogram/2d
 */

var Spectrogram = require('./lib/core');
var parseColor = require('color-parse');
var clamp = require('mumath/clamp');

module.exports = Spectrogram;

Spectrogram.prototype.context = '2d';
Spectrogram.prototype.autostart = false;

Spectrogram.prototype.init = function () {
	var this$1 = this;

	var ctx = this.context;

	this.count = 0;

	//render only on pushes
	this.on('push', function (magnitudes) {
		//map mags to 0..255 range limiting by db subrange
		magnitudes = magnitudes.map(function (value) { return clamp(255 * (1 + value / 100), 0, 255); });

		this$1.render(magnitudes);
		this$1.count++;
	});


	//on color update
	this.on('update', function () {
		this$1.colorValues = parseColor(this$1.color).values;
		this$1.bgValues = parseColor(this$1.canvas.style.background).values;
	});
};


//get mapped frequency
function lg (x) {
	return Math.log(x) / Math.log(10);
}

Spectrogram.prototype.f = function (ratio) {
	var halfRate = this.sampleRate * .5;
	if (this.logarithmic) {
		var logF = Math.pow(10., Math.log10(this.minFrequency) + ratio * (Math.log10(this.maxFrequency) - Math.log10(this.minFrequency)) );
		ratio = (logF - this.minFrequency) / (this.maxFrequency - this.minFrequency);
	}

	var leftF = this.minFrequency / halfRate;
	var rightF = this.maxFrequency / halfRate;

	ratio = leftF + ratio * (rightF - leftF);

	return ratio;
}

//return color based on current palette
Spectrogram.prototype.getColor = function (ratio) {
	var cm = this.fillData;
	ratio = clamp(ratio, 0, 1);
	var idx = ratio*(cm.length*.25 - 1);
	var amt = idx % 1;
	var left = cm.slice(Math.floor(idx)*4, Math.floor(idx)*4 + 4);
	var right = cm.slice(Math.ceil(idx)*4, Math.ceil(idx)*4 + 4);
	var values = left.map(function (v,i) { return (v * (1 - amt) + right[i] * amt)|0; } );
	return values;
}


Spectrogram.prototype.draw = function (data) {
	var this$1 = this;

	var ctx = this.context;
	var width = this.viewport[2],
		height = this.viewport[3];

	if (!this.bgValues) {
		return;
	}

	var padding = 5;

	if (this.count < this.viewport[1] + width - padding) {
		var offset = this.count;
	}
	else {
		//displace canvas
		var imgData = ctx.getImageData(this.viewport[0], this.viewport[1], width, height);
		ctx.putImageData(imgData, this.viewport[0]-1, this.viewport[1]);
		var offset = this.viewport[0] + width - padding - 1;
	}

	//put new slice
	var imgData = ctx.getImageData(offset, this.viewport[1], 1, height);
	var pixels = imgData.data;

	for (var i = 0; i < height; i++) {
		var ratio = i / height;
		var amt = data[(this$1.f(ratio) * data.length)|0] / 255;
		amt = (amt * 100. - 100 - this$1.minDecibels) / (this$1.maxDecibels - this$1.minDecibels);
		var values = this$1.getColor(amt);
		values[3] *= 255;
		pixels.set(values, (height - i - 1)*4);
	}
	ctx.putImageData(imgData, offset, 0);

}


},{"./lib/core":2,"color-parse":18,"mumath/clamp":48}],2:[function(require,module,exports){
/**
 * @module  gl-spectrogram/lib/core
 */


var extend = require('xtend/mutable');
var Component = require('gl-component');
var inherits = require('inherits');
var isBrowser = require('is-browser');
var createGrid = require('plot-grid');
var flatten = require('flatten');
var lg = require('mumath/lg');
var clamp = require('mumath/clamp');
var weighting = require('a-weighting');
var colormap = require('colormap');
var parseColor = require('color-parse');
var hsl = require('color-space/hsl');
var colorScales = require('colormap/colorScale');

module.exports = Spectrogram;



/**
 * @contructor
 */
function Spectrogram (options) {
	if (!(this instanceof Spectrogram)) return new Spectrogram(options);

	Component.call(this, options);

	if (isBrowser) this.container.classList.add(this.className);

	this.init();

	//preset initial freqs

	this.push(this.magnitudes);

	//init style props
	this.update();
}

inherits(Spectrogram, Component);

Spectrogram.prototype.className = 'gl-spectrogram';

Spectrogram.prototype.init = function () {};

Spectrogram.prototype.antialias = false;
Spectrogram.prototype.premultipliedAlpha = true;
Spectrogram.prototype.alpha = true;
Spectrogram.prototype.float = false;

Spectrogram.prototype.maxDecibels = -30;
Spectrogram.prototype.minDecibels = -90;

Spectrogram.prototype.maxFrequency = 20000;
Spectrogram.prototype.minFrequency = 40;

Spectrogram.prototype.smoothing = 0.75;
Spectrogram.prototype.details = 1;

Spectrogram.prototype.grid = true;
Spectrogram.prototype.axes = false;
Spectrogram.prototype.logarithmic = true;
Spectrogram.prototype.weighting = 'itu';
Spectrogram.prototype.sampleRate = 44100;

Spectrogram.prototype.fill = 'greys';
Spectrogram.prototype.background = undefined;



//array with initial values of the last moment
Spectrogram.prototype.magnitudes = Array(1024).fill(-150);


//set last actual frequencies values
Spectrogram.prototype.push = function (magnitudes) {
	var this$1 = this;

	if (!magnitudes) magnitudes = [-150];

	var gl = this.gl;
	var halfRate = this.sampleRate * 0.5;
	var l = halfRate / this.magnitudes.length;
	var w = weighting[this.weighting] || weighting.z;

	magnitudes = [].slice.call(magnitudes);

	//apply weighting and clamping
	for (var i = 0; i < magnitudes.length; i++) {
		var v = magnitudes[i];
		magnitudes[i] = clamp(clamp(v, -100, 0) + 20 * Math.log(w(i * l)) / Math.log(10), -200, 0);
	}

	var smoothing = this.smoothing;

	for (var i = 0; i < magnitudes.length; i++) {
		magnitudes[i] = magnitudes[i] * (1 - smoothing) + this$1.magnitudes[Math.floor(this$1.magnitudes.length * (i / magnitudes.length))] * smoothing;
	}

	//save actual magnitudes in db
	this.magnitudes = magnitudes;

	//find peak
	this.peak = this.magnitudes.reduce(function (prev, curr) { return Math.max(curr, prev); }, -200);
	//emit magnitudes in db range
	this.emit('push', magnitudes, this.peak);

	return this;
};


/**
 * Reset colormap
 */
Spectrogram.prototype.setFill = function (cm, inverse) {
	this.fill = cm;
	this.inversed = inverse;

	//named colormap
	if (typeof cm === 'string') {
		//a color scale
		if (colorScales[cm]) {
			var cm = (flatten(colormap({
				colormap: cm,
				nshades: 128,
				format: 'rgba',
				alpha: 1
			})));//.map((v,i) => !((i + 1) % 4) ? v : v/255));
		}
		//url
		else if (/\\|\//.test(cm)) {
			this.setTexture('fill', cm);
			return this;
		}
		//plain color or CSS color string
		else {
			var parsed = parseColor(cm);

			if (parsed.space === 'hsl') {
				cm = hsl.rgb(parsed.values);
			}
			else {
				cm = parsed.values;
			}
		}
	}
	else if (!cm) {
		if (!this.background) this.setBackground([0,0,0,1]);
		return this;
	}
	//image, canvas etc
	else if (!Array.isArray(cm)) {
		this.setTexture('fill', cm);

		return this;
	}
	//custom array, like palette etc.
	else {
		cm = flatten(cm);
	}

	if (inverse) {
		var reverse = cm.slice();
		for (var i = 0; i < cm.length; i+=4){
			reverse[cm.length - i - 1] = cm[i + 3];
			reverse[cm.length - i - 2] = cm[i + 2];
			reverse[cm.length - i - 3] = cm[i + 1];
			reverse[cm.length - i - 4] = cm[i + 0];
		}
		cm = reverse;
	}

	this.setTexture('fill', {
		data: cm,
		height: 1,
		width: (cm.length / 4)|0
	});

	//ensure bg
	if (!this.background) {
		this.setBackground(cm.slice(0, 4));
	}

	var mainColor = cm.slice(-4);
	this.color = "rgba(" + mainColor + ")";

	this.fillData = cm;

	//set grid color to colormap’s color
	if (this.gridComponent) {
		this.gridComponent.linesContainer.style.color = this.color;
	}

	return this;
};


/** Set background */
Spectrogram.prototype.setBackground = function (bg) {
	if (this.background !== null) {
		var bgStyle = null;
		if (typeof bg === 'string') {
			bgStyle = bg;
		}
		else if (Array.isArray(bg)) {
			//map 0..1 range to 0..255
			if (bg[0] && bg[0] <= 1 && bg[1] && bg[1] <= 1 && bg[2] && bg[2] <= 1) {
				bg = [
					bg[0] * 255, bg[1] * 255, bg[2] * 255, bg[3] || 1
				];
			}

			bgStyle = "rgba(" + (bg.slice(0,3).map(function (v) { return Math.round(v); }).join(', ')) + ", " + (bg[3]) + ")";
		}
		this.canvas.style.background = bgStyle;
	}

	return this;
};




//update view
Spectrogram.prototype.update = function () {
	var this$1 = this;

	var gl = this.gl;

	if (typeof this.smoothing === 'string') {
		this.smoothing = parseFloat(this.smoothing);
	}

	if (this.grid) {
		if (!this.gridComponent) {
			this.gridComponent = createGrid({
				container: this.container,
				viewport: function () { return this$1.viewport; },
				lines: Array.isArray(this.grid.lines) ? this.grid.lines : (this.grid.lines === undefined || this.grid.lines === true) && [{
					min: this.minFrequency,
					max: this.maxFrequency,
					orientation: 'y',
					logarithmic: this.logarithmic,
					titles: function (value) {
						return (value >= 1000 ? ((value / 1000).toLocaleString() + 'k') : value.toLocaleString()) + 'Hz';
					}
				}, this.logarithmic ? {
					min: this.minFrequency,
					max: this.maxFrequency,
					orientation: 'y',
					logarithmic: this.logarithmic,
					values: function (value) {
						var str = value.toString();
						if (str[0] !== '1') return null;
						return value;
					},
					titles: null,
					style: {
						borderLeftStyle: 'solid',
						pointerEvents: 'none',
						opacity: '0.08',
						display: this.logarithmic ? null :'none'
					}
				} : null],
				axes: Array.isArray(this.grid.axes) ? this.grid.axes : (this.grid.axes || this.axes) && [{
					name: 'Frequency',
					labels: function (value, i, opt) {
						var str = value.toString();
						if (str[0] !== '2' && str[0] !== '1' && str[0] !== '5') return null;
						return opt.titles[i];
					}
				}]
			});

			this.on('resize', function () {
				if (this$1.isPlannedGridUpdate) return;
				this$1.isPlannedGridUpdate = true;
				this$1.once('render', function () {
					this$1.isPlannedGridUpdate = false;
					this$1.gridComponent.update();
				});
			});
		}
		else {
			this.gridComponent.linesContainer.style.display = 'block';
		}
	}
	else if (this.gridComponent) {
		this.gridComponent.linesContainer.style.display = 'none';
	}

	this.setBackground(this.background);
	this.setFill(this.fill, this.inversed);

	this.emit('update');
};


},{"a-weighting":7,"color-parse":18,"color-space/hsl":19,"colormap":22,"colormap/colorScale":21,"flatten":28,"gl-component":34,"inherits":37,"is-browser":40,"mumath/clamp":48,"mumath/lg":49,"plot-grid":56,"xtend/mutable":82}],3:[function(require,module,exports){
module.exports = function a (f) {
	var f2 = f*f;
	return 1.2588966 * 148840000 * f2*f2 /
	((f2 + 424.36) * Math.sqrt((f2 + 11599.29) * (f2 + 544496.41)) * (f2 + 148840000));
};
},{}],4:[function(require,module,exports){
module.exports = function b (f) {
	var f2 = f*f;
	return 1.019764760044717 * 148840000 * f*f2 /
	((f2 + 424.36) * Math.sqrt(f2 + 25122.25) * (f2 + 148840000));
};
},{}],5:[function(require,module,exports){
module.exports = function c (f) {
	var f2 = f*f;
	return 1.0069316688518042 * 148840000 * f2 /
	((f2 + 424.36) * (f2 + 148840000));
};
},{}],6:[function(require,module,exports){
module.exports = function d (f) {
	var f2 = f*f;
	return (f / 6.8966888496476e-5) * Math.sqrt(
		(
			((1037918.48 - f2)*(1037918.48 - f2) + 1080768.16*f2) /
			((9837328 - f2)*(9837328 - f2) + 11723776*f2)
		) /	((f2 + 79919.29) * (f2 + 1345600))
	);
};
},{}],7:[function(require,module,exports){
/**
 * @module  noise-weighting
 */

module.exports = {
	a: require('./a'),
	b: require('./b'),
	c: require('./c'),
	d: require('./d'),
	m: require('./m'),
	z: require('./z')
};
},{"./a":3,"./b":4,"./c":5,"./d":6,"./m":8,"./z":9}],8:[function(require,module,exports){
module.exports = function itu (f) {
	var f2 = f*f;

	var h1 = -4.737338981378384e-24*f2*f2*f2 + 2.043828333606125e-15*f2*f2 - 1.363894795463638e-7*f2 + 1;
	var h2 = 1.306612257412824e-19*f2*f2*f - 2.118150887518656e-11*f2*f + 5.559488023498642e-4*f;

	return 8.128305161640991 * 1.246332637532143e-4 * f / Math.sqrt(h1*h1 + h2*h2);
};
},{}],9:[function(require,module,exports){
module.exports = function (f) {
	return 1;
};
},{}],10:[function(require,module,exports){
var window = require('global/window');

var Context = window.AudioContext || window.webkitAudioContext;
if (Context) module.exports = new Context;

},{"global/window":35}],11:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function placeHoldersCount (b64) {
  var len = b64.length
  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // the number of equal signs (place holders)
  // if there are two placeholders, than the two characters before it
  // represent one byte
  // if there is only one, then the three characters before it represent 2 bytes
  // this is just a cheap hack to not do indexOf twice
  return b64[len - 2] === '=' ? 2 : b64[len - 1] === '=' ? 1 : 0
}

function byteLength (b64) {
  // base64 is 4/3 + up to two characters of the original data
  return (b64.length * 3 / 4) - placeHoldersCount(b64)
}

function toByteArray (b64) {
  var i, l, tmp, placeHolders, arr
  var len = b64.length
  placeHolders = placeHoldersCount(b64)

  arr = new Arr((len * 3 / 4) - placeHolders)

  // if there are placeholders, only get up to the last complete 4 chars
  l = placeHolders > 0 ? len - 4 : len

  var L = 0

  for (i = 0; i < l; i += 4) {
    tmp = (revLookup[b64.charCodeAt(i)] << 18) | (revLookup[b64.charCodeAt(i + 1)] << 12) | (revLookup[b64.charCodeAt(i + 2)] << 6) | revLookup[b64.charCodeAt(i + 3)]
    arr[L++] = (tmp >> 16) & 0xFF
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  if (placeHolders === 2) {
    tmp = (revLookup[b64.charCodeAt(i)] << 2) | (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[L++] = tmp & 0xFF
  } else if (placeHolders === 1) {
    tmp = (revLookup[b64.charCodeAt(i)] << 10) | (revLookup[b64.charCodeAt(i + 1)] << 4) | (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] + lookup[num >> 12 & 0x3F] + lookup[num >> 6 & 0x3F] + lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var output = ''
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    output += lookup[tmp >> 2]
    output += lookup[(tmp << 4) & 0x3F]
    output += '=='
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + (uint8[len - 1])
    output += lookup[tmp >> 10]
    output += lookup[(tmp >> 4) & 0x3F]
    output += lookup[(tmp << 2) & 0x3F]
    output += '='
  }

  parts.push(output)

  return parts.join('')
}

},{}],12:[function(require,module,exports){
// sourced from:
// http://www.leanbackplayer.com/test/h5mt.html
// https://github.com/broofa/node-mime/blob/master/types.json
var mimeTypes = require('./mime-types.json')

var mimeLookup = {}
Object.keys(mimeTypes).forEach(function (key) {
  var extensions = mimeTypes[key]
  extensions.forEach(function (ext) {
    mimeLookup[ext] = key
  })
})

module.exports = function lookup (ext) {
  if (!ext) throw new TypeError('must specify extension string')
  if (ext.indexOf('.') === 0) {
    ext = ext.substring(1)
  }
  return mimeLookup[ext.toLowerCase()]
}

},{"./mime-types.json":13}],13:[function(require,module,exports){
module.exports={
  "audio/midi": ["mid", "midi", "kar", "rmi"],
  "audio/mp4": ["mp4a", "m4a"],
  "audio/mpeg": ["mpga", "mp2", "mp2a", "mp3", "m2a", "m3a"],
  "audio/ogg": ["oga", "ogg", "spx"],
  "audio/webm": ["weba"],
  "audio/x-matroska": ["mka"],
  "audio/x-mpegurl": ["m3u"],
  "audio/wav": ["wav"],
  "video/3gpp": ["3gp"],
  "video/3gpp2": ["3g2"],
  "video/mp4": ["mp4", "mp4v", "mpg4"],
  "video/mpeg": ["mpeg", "mpg", "mpe", "m1v", "m2v"],
  "video/ogg": ["ogv"],
  "video/quicktime": ["qt", "mov"],
  "video/webm": ["webm"],
  "video/x-f4v": ["f4v"],
  "video/x-fli": ["fli"],
  "video/x-flv": ["flv"],
  "video/x-m4v": ["m4v"],
  "video/x-matroska": ["mkv", "mk3d", "mks"]
}
},{}],14:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var arguments$1 = arguments;

    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments$1[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],15:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = {__proto__: Uint8Array.prototype, foo: function () { return 42 }}
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('Invalid typed array length')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new Error(
        'If encoding is specified then the first argument must be a string'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number')
  }

  if (isArrayBuffer(value)) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  return fromObject(value)
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be a number')
  } else if (size < 0) {
    throw new RangeError('"size" argument must not be negative')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('"encoding" must be a valid string encoding')
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('\'offset\' is out of bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('\'length\' is out of bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj) {
    if (isArrayBufferView(obj) || 'length' in obj) {
      if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
        return createBuffer(0)
      }
      return fromArrayLike(obj)
    }

    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return fromArrayLike(obj.data)
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.')
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (isArrayBufferView(string) || isArrayBuffer(string)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    string = '' + string
  }

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
      case undefined:
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var this$1 = this;

  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this$1, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this$1, start, end)

      case 'ascii':
        return asciiSlice(this$1, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this$1, start, end)

      case 'base64':
        return base64Slice(this$1, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this$1, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var this$1 = this;

  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this$1, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var this$1 = this;

  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this$1, i, i + 3)
    swap(this$1, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var this$1 = this;

  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this$1, i, i + 7)
    swap(this$1, i + 1, i + 6)
    swap(this$1, i + 2, i + 5)
    swap(this$1, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (!Buffer.isBuffer(target)) {
    throw new TypeError('Argument must be a Buffer')
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset  // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new TypeError('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  var this$1 = this;

  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this$1, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this$1, string, offset, length)

      case 'ascii':
        return asciiWrite(this$1, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this$1, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this$1, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this$1, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  var this$1 = this;

  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this$1[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  var this$1 = this;

  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this$1[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  var this$1 = this;

  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this$1[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  var this$1 = this;

  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this$1[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  var this$1 = this;

  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this$1[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  var this$1 = this;

  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this$1[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  var this$1 = this;

  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this$1[offset + i - 1] !== 0) {
      sub = 1
    }
    this$1[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  var this$1 = this;

  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this$1[offset + i + 1] !== 0) {
      sub = 1
    }
    this$1[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  var this$1 = this;

  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this$1[i + start]
    }
  } else if (len < 1000) {
    // ascending copy from start
    for (i = 0; i < len; ++i) {
      target[i + targetStart] = this$1[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, start + len),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  var this$1 = this;

  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if (code < 256) {
        val = code
      }
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this$1[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : new Buffer(val, encoding)
    var len = bytes.length
    for (i = 0; i < end - start; ++i) {
      this$1[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffers from another context (i.e. an iframe) do not pass the `instanceof` check
// but they should be treated as valid. See: https://github.com/feross/buffer/issues/166
function isArrayBuffer (obj) {
  return obj instanceof ArrayBuffer ||
    (obj != null && obj.constructor != null && obj.constructor.name === 'ArrayBuffer' &&
      typeof obj.byteLength === 'number')
}

// Node 0.10 supports `ArrayBuffer` but lacks `ArrayBuffer.isView`
function isArrayBufferView (obj) {
  return (typeof ArrayBuffer.isView === 'function') && ArrayBuffer.isView(obj)
}

function numberIsNaN (obj) {
  return obj !== obj // eslint-disable-line no-self-compare
}

},{"base64-js":11,"ieee754":36}],16:[function(require,module,exports){
var size = require('element-size')

module.exports = fit

var scratch = new Float32Array(2)

function fit(canvas, parent, scale) {
  var isSVG = canvas.nodeName.toUpperCase() === 'SVG'

  canvas.style.position = canvas.style.position || 'absolute'
  canvas.style.top = 0
  canvas.style.left = 0

  resize.scale  = parseFloat(scale || 1)
  resize.parent = parent

  return resize()

  function resize() {
    var p = resize.parent || canvas.parentNode
    if (typeof p === 'function') {
      var dims   = p(scratch) || scratch
      var width  = dims[0]
      var height = dims[1]
    } else
    if (p && p !== document.body) {
      var psize  = size(p)
      var width  = psize[0]|0
      var height = psize[1]|0
    } else {
      var width  = window.innerWidth
      var height = window.innerHeight
    }

    if (isSVG) {
      canvas.setAttribute('width', width * resize.scale + 'px')
      canvas.setAttribute('height', height * resize.scale + 'px')
    } else {
      canvas.width = width * resize.scale
      canvas.height = height * resize.scale
    }

    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'

    return resize
  }
}

},{"element-size":26}],17:[function(require,module,exports){
'use strict'

module.exports = {
	"aliceblue": [240, 248, 255],
	"antiquewhite": [250, 235, 215],
	"aqua": [0, 255, 255],
	"aquamarine": [127, 255, 212],
	"azure": [240, 255, 255],
	"beige": [245, 245, 220],
	"bisque": [255, 228, 196],
	"black": [0, 0, 0],
	"blanchedalmond": [255, 235, 205],
	"blue": [0, 0, 255],
	"blueviolet": [138, 43, 226],
	"brown": [165, 42, 42],
	"burlywood": [222, 184, 135],
	"cadetblue": [95, 158, 160],
	"chartreuse": [127, 255, 0],
	"chocolate": [210, 105, 30],
	"coral": [255, 127, 80],
	"cornflowerblue": [100, 149, 237],
	"cornsilk": [255, 248, 220],
	"crimson": [220, 20, 60],
	"cyan": [0, 255, 255],
	"darkblue": [0, 0, 139],
	"darkcyan": [0, 139, 139],
	"darkgoldenrod": [184, 134, 11],
	"darkgray": [169, 169, 169],
	"darkgreen": [0, 100, 0],
	"darkgrey": [169, 169, 169],
	"darkkhaki": [189, 183, 107],
	"darkmagenta": [139, 0, 139],
	"darkolivegreen": [85, 107, 47],
	"darkorange": [255, 140, 0],
	"darkorchid": [153, 50, 204],
	"darkred": [139, 0, 0],
	"darksalmon": [233, 150, 122],
	"darkseagreen": [143, 188, 143],
	"darkslateblue": [72, 61, 139],
	"darkslategray": [47, 79, 79],
	"darkslategrey": [47, 79, 79],
	"darkturquoise": [0, 206, 209],
	"darkviolet": [148, 0, 211],
	"deeppink": [255, 20, 147],
	"deepskyblue": [0, 191, 255],
	"dimgray": [105, 105, 105],
	"dimgrey": [105, 105, 105],
	"dodgerblue": [30, 144, 255],
	"firebrick": [178, 34, 34],
	"floralwhite": [255, 250, 240],
	"forestgreen": [34, 139, 34],
	"fuchsia": [255, 0, 255],
	"gainsboro": [220, 220, 220],
	"ghostwhite": [248, 248, 255],
	"gold": [255, 215, 0],
	"goldenrod": [218, 165, 32],
	"gray": [128, 128, 128],
	"green": [0, 128, 0],
	"greenyellow": [173, 255, 47],
	"grey": [128, 128, 128],
	"honeydew": [240, 255, 240],
	"hotpink": [255, 105, 180],
	"indianred": [205, 92, 92],
	"indigo": [75, 0, 130],
	"ivory": [255, 255, 240],
	"khaki": [240, 230, 140],
	"lavender": [230, 230, 250],
	"lavenderblush": [255, 240, 245],
	"lawngreen": [124, 252, 0],
	"lemonchiffon": [255, 250, 205],
	"lightblue": [173, 216, 230],
	"lightcoral": [240, 128, 128],
	"lightcyan": [224, 255, 255],
	"lightgoldenrodyellow": [250, 250, 210],
	"lightgray": [211, 211, 211],
	"lightgreen": [144, 238, 144],
	"lightgrey": [211, 211, 211],
	"lightpink": [255, 182, 193],
	"lightsalmon": [255, 160, 122],
	"lightseagreen": [32, 178, 170],
	"lightskyblue": [135, 206, 250],
	"lightslategray": [119, 136, 153],
	"lightslategrey": [119, 136, 153],
	"lightsteelblue": [176, 196, 222],
	"lightyellow": [255, 255, 224],
	"lime": [0, 255, 0],
	"limegreen": [50, 205, 50],
	"linen": [250, 240, 230],
	"magenta": [255, 0, 255],
	"maroon": [128, 0, 0],
	"mediumaquamarine": [102, 205, 170],
	"mediumblue": [0, 0, 205],
	"mediumorchid": [186, 85, 211],
	"mediumpurple": [147, 112, 219],
	"mediumseagreen": [60, 179, 113],
	"mediumslateblue": [123, 104, 238],
	"mediumspringgreen": [0, 250, 154],
	"mediumturquoise": [72, 209, 204],
	"mediumvioletred": [199, 21, 133],
	"midnightblue": [25, 25, 112],
	"mintcream": [245, 255, 250],
	"mistyrose": [255, 228, 225],
	"moccasin": [255, 228, 181],
	"navajowhite": [255, 222, 173],
	"navy": [0, 0, 128],
	"oldlace": [253, 245, 230],
	"olive": [128, 128, 0],
	"olivedrab": [107, 142, 35],
	"orange": [255, 165, 0],
	"orangered": [255, 69, 0],
	"orchid": [218, 112, 214],
	"palegoldenrod": [238, 232, 170],
	"palegreen": [152, 251, 152],
	"paleturquoise": [175, 238, 238],
	"palevioletred": [219, 112, 147],
	"papayawhip": [255, 239, 213],
	"peachpuff": [255, 218, 185],
	"peru": [205, 133, 63],
	"pink": [255, 192, 203],
	"plum": [221, 160, 221],
	"powderblue": [176, 224, 230],
	"purple": [128, 0, 128],
	"rebeccapurple": [102, 51, 153],
	"red": [255, 0, 0],
	"rosybrown": [188, 143, 143],
	"royalblue": [65, 105, 225],
	"saddlebrown": [139, 69, 19],
	"salmon": [250, 128, 114],
	"sandybrown": [244, 164, 96],
	"seagreen": [46, 139, 87],
	"seashell": [255, 245, 238],
	"sienna": [160, 82, 45],
	"silver": [192, 192, 192],
	"skyblue": [135, 206, 235],
	"slateblue": [106, 90, 205],
	"slategray": [112, 128, 144],
	"slategrey": [112, 128, 144],
	"snow": [255, 250, 250],
	"springgreen": [0, 255, 127],
	"steelblue": [70, 130, 180],
	"tan": [210, 180, 140],
	"teal": [0, 128, 128],
	"thistle": [216, 191, 216],
	"tomato": [255, 99, 71],
	"turquoise": [64, 224, 208],
	"violet": [238, 130, 238],
	"wheat": [245, 222, 179],
	"white": [255, 255, 255],
	"whitesmoke": [245, 245, 245],
	"yellow": [255, 255, 0],
	"yellowgreen": [154, 205, 50]
};
},{}],18:[function(require,module,exports){
(function (global){
/**
 * @module color-parse
 */

'use strict'


module.exports = parse;


var names = require('color-name');
var isObject = require('is-plain-obj');


/**
 * Base hues
 * http://dev.w3.org/csswg/css-color/#typedef-named-hue
 */
//FIXME: use external hue detector
var baseHues = {
	red: 0,
	orange: 60,
	yellow: 120,
	green: 180,
	blue: 240,
	purple: 300
};


/**
 * Parse color from the string passed
 *
 * @return {Object} A space indicator `space`, an array `values` and `alpha`
 */
function parse (cstr) {
	var m, parts = [], alpha = 1, space;

	if (typeof cstr === 'string') {
		//keyword
		if (names[cstr]) {
			parts = names[cstr].slice();
			space = 'rgb'
		}

		//reserved words
		else if (cstr === 'transparent') {
			alpha = 0;
			space = 'rgb'
			parts = [0,0,0]
		}

		//hex
		else if (/^#[A-Fa-f0-9]+$/.test(cstr)) {
			var base = cstr.slice(1);
			var size = base.length;
			var isShort = size <= 4;
			alpha = 1;

			if (isShort) {
				parts = [
					parseInt(base[0] + base[0], 16),
					parseInt(base[1] + base[1], 16),
					parseInt(base[2] + base[2], 16)
				]
				if (size === 4) {
					alpha = parseInt(base[3] + base[3], 16) / 255
				}
			}
			else {
				parts = [
					parseInt(base[0] + base[1], 16),
					parseInt(base[2] + base[3], 16),
					parseInt(base[4] + base[5], 16)
				]
				if (size === 8) {
					alpha = parseInt(base[6] + base[7], 16) / 255
				}
			}

			if (!parts[0]) parts[0] = 0;
			if (!parts[1]) parts[1] = 0;
			if (!parts[2]) parts[2] = 0;

			space = 'rgb'
		}

		//color space
		else if (m = /^((?:rgb|hs[lvb]|hwb|cmyk?|xy[zy]|gray|lab|lchu?v?|[ly]uv|lms)a?)\s*\(([^\)]*)\)/.exec(cstr)) {
			var name = m[1];
			var base = name.replace(/a$/, '');
			space = base;
			var size = base === 'cmyk' ? 4 : base === 'gray' ? 1 : 3;
			parts = m[2].trim()
				.split(/\s*,\s*/)
				.map(function (x, i) {
					//<percentage>
					if (/%$/.test(x)) {
						//alpha
						if (i === size)	return parseFloat(x) / 100;
						//rgb
						if (base === 'rgb') return parseFloat(x) * 255 / 100;
						return parseFloat(x);
					}
					//hue
					else if (base[i] === 'h') {
						//<deg>
						if (/deg$/.test(x)) {
							return parseFloat(x);
						}
						//<base-hue>
						else if (baseHues[x] !== undefined) {
							return baseHues[x];
						}
					}
					return parseFloat(x);
				});

			if (name === base) parts.push(1);
			alpha = parts[size] === undefined ? 1 : parts[size];
			parts = parts.slice(0, size);
		}

		//named channels case
		else if (cstr.length > 10 && /[0-9](?:\s|\/)/.test(cstr)) {
			parts = cstr.match(/([0-9]+)/g).map(function (value) {
				return parseFloat(value);
			});

			space = cstr.match(/([a-z])/ig).join('').toLowerCase();
		}
	}

	//numeric case
	else if (typeof cstr === 'number') {
		space = 'rgb'
		parts = [cstr >>> 16, (cstr & 0x00ff00) >>> 8, cstr & 0x0000ff];
	}

	//object case - detects css cases of rgb and hsl
	else if (isObject(cstr)) {
		if (cstr.r != null) {
			parts = [cstr.r, cstr.g, cstr.b];
			space = 'rgb'
		}
		else if (cstr.red != null) {
			parts = [cstr.red, cstr.green, cstr.blue];
			space = 'rgb'
		}
		else if (cstr.h != null) {
			parts = [cstr.h, cstr.s, cstr.l];
			space = 'hsl';
		}
		else if (cstr.hue != null) {
			parts = [cstr.hue, cstr.saturation, cstr.lightness];
			space = 'hsl';
		}

		if (cstr.a != null) alpha = cstr.a;
		else if (cstr.alpha != null) alpha = cstr.alpha;
		else if (cstr.opacity != null) alpha = cstr.opacity / 100;
	}

	//array
	else if (Array.isArray(cstr) || global.ArrayBuffer && ArrayBuffer.isView && ArrayBuffer.isView(cstr)) {
		parts = [cstr[0], cstr[1], cstr[2]];
		space = 'rgb'
		alpha = cstr.length === 4 ? cstr[3] : 1;
	}

	return {
		space: space,
		values: parts,
		alpha: alpha
	};
}
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"color-name":17,"is-plain-obj":44}],19:[function(require,module,exports){
/**
 * @module color-space/hsl
 */
'use strict'

var rgb = require('./rgb');

module.exports = {
	name: 'hsl',
	min: [0,0,0],
	max: [360,100,100],
	channel: ['hue', 'saturation', 'lightness'],
	alias: ['HSL'],

	rgb: function(hsl) {
		var h = hsl[0] / 360,
				s = hsl[1] / 100,
				l = hsl[2] / 100,
				t1, t2, t3, rgb, val;

		if (s === 0) {
			val = l * 255;
			return [val, val, val];
		}

		if (l < 0.5) {
			t2 = l * (1 + s);
		}
		else {
			t2 = l + s - l * s;
		}
		t1 = 2 * l - t2;

		rgb = [0, 0, 0];
		for (var i = 0; i < 3; i++) {
			t3 = h + 1 / 3 * - (i - 1);
			if (t3 < 0) {
				t3++;
			}
			else if (t3 > 1) {
				t3--;
			}

			if (6 * t3 < 1) {
				val = t1 + (t2 - t1) * 6 * t3;
			}
			else if (2 * t3 < 1) {
				val = t2;
			}
			else if (3 * t3 < 2) {
				val = t1 + (t2 - t1) * (2 / 3 - t3) * 6;
			}
			else {
				val = t1;
			}

			rgb[i] = val * 255;
		}

		return rgb;
	}
};


//extend rgb
rgb.hsl = function(rgb) {
	var r = rgb[0]/255,
			g = rgb[1]/255,
			b = rgb[2]/255,
			min = Math.min(r, g, b),
			max = Math.max(r, g, b),
			delta = max - min,
			h, s, l;

	if (max === min) {
		h = 0;
	}
	else if (r === max) {
		h = (g - b) / delta;
	}
	else if (g === max) {
		h = 2 + (b - r) / delta;
	}
	else if (b === max) {
		h = 4 + (r - g)/ delta;
	}

	h = Math.min(h * 60, 360);

	if (h < 0) {
		h += 360;
	}

	l = (min + max) / 2;

	if (max === min) {
		s = 0;
	}
	else if (l <= 0.5) {
		s = delta / (max + min);
	}
	else {
		s = delta / (2 - max - min);
	}

	return [h, s * 100, l * 100];
};

},{"./rgb":20}],20:[function(require,module,exports){
/**
 * RGB space.
 *
 * @module  color-space/rgb
 */
'use strict'

module.exports = {
	name: 'rgb',
	min: [0,0,0],
	max: [255,255,255],
	channel: ['red', 'green', 'blue'],
	alias: ['RGB']
};

},{}],21:[function(require,module,exports){
module.exports={
	"jet":[{"index":0,"rgb":[0,0,131]},{"index":0.125,"rgb":[0,60,170]},{"index":0.375,"rgb":[5,255,255]},{"index":0.625,"rgb":[255,255,0]},{"index":0.875,"rgb":[250,0,0]},{"index":1,"rgb":[128,0,0]}],

	"hsv":[{"index":0,"rgb":[255,0,0]},{"index":0.169,"rgb":[253,255,2]},{"index":0.173,"rgb":[247,255,2]},{"index":0.337,"rgb":[0,252,4]},{"index":0.341,"rgb":[0,252,10]},{"index":0.506,"rgb":[1,249,255]},{"index":0.671,"rgb":[2,0,253]},{"index":0.675,"rgb":[8,0,253]},{"index":0.839,"rgb":[255,0,251]},{"index":0.843,"rgb":[255,0,245]},{"index":1,"rgb":[255,0,6]}],

	"hot":[{"index":0,"rgb":[0,0,0]},{"index":0.3,"rgb":[230,0,0]},{"index":0.6,"rgb":[255,210,0]},{"index":1,"rgb":[255,255,255]}],

	"cool":[{"index":0,"rgb":[0,255,255]},{"index":1,"rgb":[255,0,255]}],

	"spring":[{"index":0,"rgb":[255,0,255]},{"index":1,"rgb":[255,255,0]}],

	"summer":[{"index":0,"rgb":[0,128,102]},{"index":1,"rgb":[255,255,102]}],

	"autumn":[{"index":0,"rgb":[255,0,0]},{"index":1,"rgb":[255,255,0]}],

	"winter":[{"index":0,"rgb":[0,0,255]},{"index":1,"rgb":[0,255,128]}],

	"bone":[{"index":0,"rgb":[0,0,0]},{"index":0.376,"rgb":[84,84,116]},{"index":0.753,"rgb":[169,200,200]},{"index":1,"rgb":[255,255,255]}],

	"copper":[{"index":0,"rgb":[0,0,0]},{"index":0.804,"rgb":[255,160,102]},{"index":1,"rgb":[255,199,127]}],

	"greys":[{"index":0,"rgb":[0,0,0]},{"index":1,"rgb":[255,255,255]}],

	"yignbu":[{"index":0,"rgb":[8,29,88]},{"index":0.125,"rgb":[37,52,148]},{"index":0.25,"rgb":[34,94,168]},{"index":0.375,"rgb":[29,145,192]},{"index":0.5,"rgb":[65,182,196]},{"index":0.625,"rgb":[127,205,187]},{"index":0.75,"rgb":[199,233,180]},{"index":0.875,"rgb":[237,248,217]},{"index":1,"rgb":[255,255,217]}],

	"greens":[{"index":0,"rgb":[0,68,27]},{"index":0.125,"rgb":[0,109,44]},{"index":0.25,"rgb":[35,139,69]},{"index":0.375,"rgb":[65,171,93]},{"index":0.5,"rgb":[116,196,118]},{"index":0.625,"rgb":[161,217,155]},{"index":0.75,"rgb":[199,233,192]},{"index":0.875,"rgb":[229,245,224]},{"index":1,"rgb":[247,252,245]}],

	"yiorrd":[{"index":0,"rgb":[128,0,38]},{"index":0.125,"rgb":[189,0,38]},{"index":0.25,"rgb":[227,26,28]},{"index":0.375,"rgb":[252,78,42]},{"index":0.5,"rgb":[253,141,60]},{"index":0.625,"rgb":[254,178,76]},{"index":0.75,"rgb":[254,217,118]},{"index":0.875,"rgb":[255,237,160]},{"index":1,"rgb":[255,255,204]}],

	"bluered":[{"index":0,"rgb":[0,0,255]},{"index":1,"rgb":[255,0,0]}],

	"rdbu":[{"index":0,"rgb":[5,10,172]},{"index":0.35,"rgb":[106,137,247]},{"index":0.5,"rgb":[190,190,190]},{"index":0.6,"rgb":[220,170,132]},{"index":0.7,"rgb":[230,145,90]},{"index":1,"rgb":[178,10,28]}],

	"picnic":[{"index":0,"rgb":[0,0,255]},{"index":0.1,"rgb":[51,153,255]},{"index":0.2,"rgb":[102,204,255]},{"index":0.3,"rgb":[153,204,255]},{"index":0.4,"rgb":[204,204,255]},{"index":0.5,"rgb":[255,255,255]},{"index":0.6,"rgb":[255,204,255]},{"index":0.7,"rgb":[255,153,255]},{"index":0.8,"rgb":[255,102,204]},{"index":0.9,"rgb":[255,102,102]},{"index":1,"rgb":[255,0,0]}],

	"rainbow":[{"index":0,"rgb":[150,0,90]},{"index":0.125,"rgb":[0,0,200]},{"index":0.25,"rgb":[0,25,255]},{"index":0.375,"rgb":[0,152,255]},{"index":0.5,"rgb":[44,255,150]},{"index":0.625,"rgb":[151,255,0]},{"index":0.75,"rgb":[255,234,0]},{"index":0.875,"rgb":[255,111,0]},{"index":1,"rgb":[255,0,0]}],

	"portland":[{"index":0,"rgb":[12,51,131]},{"index":0.25,"rgb":[10,136,186]},{"index":0.5,"rgb":[242,211,56]},{"index":0.75,"rgb":[242,143,56]},{"index":1,"rgb":[217,30,30]}],

	"blackbody":[{"index":0,"rgb":[0,0,0]},{"index":0.2,"rgb":[230,0,0]},{"index":0.4,"rgb":[230,210,0]},{"index":0.7,"rgb":[255,255,255]},{"index":1,"rgb":[160,200,255]}],

	"earth":[{"index":0,"rgb":[0,0,130]},{"index":0.1,"rgb":[0,180,180]},{"index":0.2,"rgb":[40,210,40]},{"index":0.4,"rgb":[230,230,50]},{"index":0.6,"rgb":[120,70,20]},{"index":1,"rgb":[255,255,255]}],

	"electric":[{"index":0,"rgb":[0,0,0]},{"index":0.15,"rgb":[30,0,100]},{"index":0.4,"rgb":[120,0,100]},{"index":0.6,"rgb":[160,90,0]},{"index":0.8,"rgb":[230,200,0]},{"index":1,"rgb":[255,250,220]}],

	"alpha": [{"index":0, "rgb": [255,255,255,0]},{"index":1, "rgb": [255,255,255,1]}],

	"viridis": [{"index":0,"rgb":[68,1,84]},{"index":0.13,"rgb":[71,44,122]},{"index":0.25,"rgb":[59,81,139]},{"index":0.38,"rgb":[44,113,142]},{"index":0.5,"rgb":[33,144,141]},{"index":0.63,"rgb":[39,173,129]},{"index":0.75,"rgb":[92,200,99]},{"index":0.88,"rgb":[170,220,50]},{"index":1,"rgb":[253,231,37]}],

	"inferno": [{"index":0,"rgb":[0,0,4]},{"index":0.13,"rgb":[31,12,72]},{"index":0.25,"rgb":[85,15,109]},{"index":0.38,"rgb":[136,34,106]},{"index":0.5,"rgb":[186,54,85]},{"index":0.63,"rgb":[227,89,51]},{"index":0.75,"rgb":[249,140,10]},{"index":0.88,"rgb":[249,201,50]},{"index":1,"rgb":[252,255,164]}],

	"magma": [{"index":0,"rgb":[0,0,4]},{"index":0.13,"rgb":[28,16,68]},{"index":0.25,"rgb":[79,18,123]},{"index":0.38,"rgb":[129,37,129]},{"index":0.5,"rgb":[181,54,122]},{"index":0.63,"rgb":[229,80,100]},{"index":0.75,"rgb":[251,135,97]},{"index":0.88,"rgb":[254,194,135]},{"index":1,"rgb":[252,253,191]}],

	"plasma": [{"index":0,"rgb":[13,8,135]},{"index":0.13,"rgb":[75,3,161]},{"index":0.25,"rgb":[125,3,168]},{"index":0.38,"rgb":[168,34,150]},{"index":0.5,"rgb":[203,70,121]},{"index":0.63,"rgb":[229,107,93]},{"index":0.75,"rgb":[248,148,65]},{"index":0.88,"rgb":[253,195,40]},{"index":1,"rgb":[240,249,33]}],

	"warm": [{"index":0,"rgb":[125,0,179]},{"index":0.13,"rgb":[172,0,187]},{"index":0.25,"rgb":[219,0,170]},{"index":0.38,"rgb":[255,0,130]},{"index":0.5,"rgb":[255,63,74]},{"index":0.63,"rgb":[255,123,0]},{"index":0.75,"rgb":[234,176,0]},{"index":0.88,"rgb":[190,228,0]},{"index":1,"rgb":[147,255,0]}],

	"cool": [{"index":0,"rgb":[125,0,179]},{"index":0.13,"rgb":[116,0,218]},{"index":0.25,"rgb":[98,74,237]},{"index":0.38,"rgb":[68,146,231]},{"index":0.5,"rgb":[0,204,197]},{"index":0.63,"rgb":[0,247,146]},{"index":0.75,"rgb":[0,255,88]},{"index":0.88,"rgb":[40,255,8]},{"index":1,"rgb":[147,255,0]}],

	"rainbow-soft": [{"index":0,"rgb":[125,0,179]},{"index":0.1,"rgb":[199,0,180]},{"index":0.2,"rgb":[255,0,121]},{"index":0.3,"rgb":[255,108,0]},{"index":0.4,"rgb":[222,194,0]},{"index":0.5,"rgb":[150,255,0]},{"index":0.6,"rgb":[0,255,55]},{"index":0.7,"rgb":[0,246,150]},{"index":0.8,"rgb":[50,167,222]},{"index":0.9,"rgb":[103,51,235]},{"index":1,"rgb":[124,0,186]}],

	"bathymetry": [{"index":0,"rgb":[40,26,44]},{"index":0.13,"rgb":[59,49,90]},{"index":0.25,"rgb":[64,76,139]},{"index":0.38,"rgb":[63,110,151]},{"index":0.5,"rgb":[72,142,158]},{"index":0.63,"rgb":[85,174,163]},{"index":0.75,"rgb":[120,206,163]},{"index":0.88,"rgb":[187,230,172]},{"index":1,"rgb":[253,254,204]}],

	"cdom": [{"index":0,"rgb":[47,15,62]},{"index":0.13,"rgb":[87,23,86]},{"index":0.25,"rgb":[130,28,99]},{"index":0.38,"rgb":[171,41,96]},{"index":0.5,"rgb":[206,67,86]},{"index":0.63,"rgb":[230,106,84]},{"index":0.75,"rgb":[242,149,103]},{"index":0.88,"rgb":[249,193,135]},{"index":1,"rgb":[254,237,176]}],

	"chlorophyll": [{"index":0,"rgb":[18,36,20]},{"index":0.13,"rgb":[25,63,41]},{"index":0.25,"rgb":[24,91,59]},{"index":0.38,"rgb":[13,119,72]},{"index":0.5,"rgb":[18,148,80]},{"index":0.63,"rgb":[80,173,89]},{"index":0.75,"rgb":[132,196,122]},{"index":0.88,"rgb":[175,221,162]},{"index":1,"rgb":[215,249,208]}],

	"density": [{"index":0,"rgb":[54,14,36]},{"index":0.13,"rgb":[89,23,80]},{"index":0.25,"rgb":[110,45,132]},{"index":0.38,"rgb":[120,77,178]},{"index":0.5,"rgb":[120,113,213]},{"index":0.63,"rgb":[115,151,228]},{"index":0.75,"rgb":[134,185,227]},{"index":0.88,"rgb":[177,214,227]},{"index":1,"rgb":[230,241,241]}],

	"freesurface-blue": [{"index":0,"rgb":[30,4,110]},{"index":0.13,"rgb":[47,14,176]},{"index":0.25,"rgb":[41,45,236]},{"index":0.38,"rgb":[25,99,212]},{"index":0.5,"rgb":[68,131,200]},{"index":0.63,"rgb":[114,156,197]},{"index":0.75,"rgb":[157,181,203]},{"index":0.88,"rgb":[200,208,216]},{"index":1,"rgb":[241,237,236]}],

	"freesurface-red": [{"index":0,"rgb":[60,9,18]},{"index":0.13,"rgb":[100,17,27]},{"index":0.25,"rgb":[142,20,29]},{"index":0.38,"rgb":[177,43,27]},{"index":0.5,"rgb":[192,87,63]},{"index":0.63,"rgb":[205,125,105]},{"index":0.75,"rgb":[216,162,148]},{"index":0.88,"rgb":[227,199,193]},{"index":1,"rgb":[241,237,236]}],

	"oxygen": [{"index":0,"rgb":[64,5,5]},{"index":0.13,"rgb":[106,6,15]},{"index":0.25,"rgb":[144,26,7]},{"index":0.38,"rgb":[168,64,3]},{"index":0.5,"rgb":[188,100,4]},{"index":0.63,"rgb":[206,136,11]},{"index":0.75,"rgb":[220,174,25]},{"index":0.88,"rgb":[231,215,44]},{"index":1,"rgb":[248,254,105]}],

	"par": [{"index":0,"rgb":[51,20,24]},{"index":0.13,"rgb":[90,32,35]},{"index":0.25,"rgb":[129,44,34]},{"index":0.38,"rgb":[159,68,25]},{"index":0.5,"rgb":[182,99,19]},{"index":0.63,"rgb":[199,134,22]},{"index":0.75,"rgb":[212,171,35]},{"index":0.88,"rgb":[221,210,54]},{"index":1,"rgb":[225,253,75]}],

	"phase": [{"index":0,"rgb":[145,105,18]},{"index":0.13,"rgb":[184,71,38]},{"index":0.25,"rgb":[186,58,115]},{"index":0.38,"rgb":[160,71,185]},{"index":0.5,"rgb":[110,97,218]},{"index":0.63,"rgb":[50,123,164]},{"index":0.75,"rgb":[31,131,110]},{"index":0.88,"rgb":[77,129,34]},{"index":1,"rgb":[145,105,18]}],

	"salinity": [{"index":0,"rgb":[42,24,108]},{"index":0.13,"rgb":[33,50,162]},{"index":0.25,"rgb":[15,90,145]},{"index":0.38,"rgb":[40,118,137]},{"index":0.5,"rgb":[59,146,135]},{"index":0.63,"rgb":[79,175,126]},{"index":0.75,"rgb":[120,203,104]},{"index":0.88,"rgb":[193,221,100]},{"index":1,"rgb":[253,239,154]}],

	"temperature": [{"index":0,"rgb":[4,35,51]},{"index":0.13,"rgb":[23,51,122]},{"index":0.25,"rgb":[85,59,157]},{"index":0.38,"rgb":[129,79,143]},{"index":0.5,"rgb":[175,95,130]},{"index":0.63,"rgb":[222,112,101]},{"index":0.75,"rgb":[249,146,66]},{"index":0.88,"rgb":[249,196,65]},{"index":1,"rgb":[232,250,91]}],

	"turbidity": [{"index":0,"rgb":[34,31,27]},{"index":0.13,"rgb":[65,50,41]},{"index":0.25,"rgb":[98,69,52]},{"index":0.38,"rgb":[131,89,57]},{"index":0.5,"rgb":[161,112,59]},{"index":0.63,"rgb":[185,140,66]},{"index":0.75,"rgb":[202,174,88]},{"index":0.88,"rgb":[216,209,126]},{"index":1,"rgb":[233,246,171]}],

	"velocity-blue": [{"index":0,"rgb":[17,32,64]},{"index":0.13,"rgb":[35,52,116]},{"index":0.25,"rgb":[29,81,156]},{"index":0.38,"rgb":[31,113,162]},{"index":0.5,"rgb":[50,144,169]},{"index":0.63,"rgb":[87,173,176]},{"index":0.75,"rgb":[149,196,189]},{"index":0.88,"rgb":[203,221,211]},{"index":1,"rgb":[254,251,230]}],

	"velocity-green": [{"index":0,"rgb":[23,35,19]},{"index":0.13,"rgb":[24,64,38]},{"index":0.25,"rgb":[11,95,45]},{"index":0.38,"rgb":[39,123,35]},{"index":0.5,"rgb":[95,146,12]},{"index":0.63,"rgb":[152,165,18]},{"index":0.75,"rgb":[201,186,69]},{"index":0.88,"rgb":[233,216,137]},{"index":1,"rgb":[255,253,205]}],

	"cubehelix": [{"index":0,"rgb":[0,0,0]},{"index":0.07,"rgb":[22,5,59]},{"index":0.13,"rgb":[60,4,105]},{"index":0.2,"rgb":[109,1,135]},{"index":0.27,"rgb":[161,0,147]},{"index":0.33,"rgb":[210,2,142]},{"index":0.4,"rgb":[251,11,123]},{"index":0.47,"rgb":[255,29,97]},{"index":0.53,"rgb":[255,54,69]},{"index":0.6,"rgb":[255,85,46]},{"index":0.67,"rgb":[255,120,34]},{"index":0.73,"rgb":[255,157,37]},{"index":0.8,"rgb":[241,191,57]},{"index":0.87,"rgb":[224,220,93]},{"index":0.93,"rgb":[218,241,142]},{"index":1,"rgb":[227,253,198]}]
};

},{}],22:[function(require,module,exports){
/*
 * Ben Postlethwaite
 * January 2013
 * License MIT
 */
'use strict';

var colorScale = require('./colorScale');
var lerp = require('lerp')

module.exports = createColormap;

function createColormap (spec) {
    /*
     * Default Options
     */
    var indicies, rgba, fromrgba, torgba,
        nsteps, cmap, colormap, format,
        nshades, colors, alpha, index, i,
        r = [],
        g = [],
        b = [],
        a = [];

    if ( !spec ) spec = {};

    nshades = (spec.nshades || 72) - 1;
    format = spec.format || 'hex';

    colormap = spec.colormap;
    if (!colormap) colormap = 'jet';

    if (typeof colormap === 'string') {
        colormap = colormap.toLowerCase();

        if (!colorScale[colormap]) {
            throw Error(colormap + ' not a supported colorscale');
        }

        cmap = colorScale[colormap];

    } else if (Array.isArray(colormap)) {
        cmap = colormap.slice();

    } else {
        throw Error('unsupported colormap option', colormap);
    }

    if (cmap.length > nshades) {
        throw new Error(
            colormap+' map requires nshades to be at least size '+cmap.length
        );
    }

    if (!Array.isArray(spec.alpha)) {

        if (typeof spec.alpha === 'number') {
            alpha = [spec.alpha, spec.alpha];

        } else {
            alpha = [1, 1];
        }

    } else if (spec.alpha.length !== 2) {
        alpha = [1, 1];

    } else {
        alpha = spec.alpha.slice();
    }

    // map index points from 0..1 to 0..n-1
    indicies = cmap.map(function(c) {
        return Math.round(c.index * nshades);
    });

    // Add alpha channel to the map
    alpha[0] = Math.min(Math.max(alpha[0], 0), 1);
    alpha[1] = Math.min(Math.max(alpha[1], 0), 1);

    var steps = cmap.map(function(c, i) {
        var index = cmap[i].index

        var rgba = cmap[i].rgb.slice();

        // if user supplies their own map use it
        if (rgba.length === 4 && rgba[3] >= 0 && rgba[3] <= 1) {
            return rgba
        }
        rgba[3] = alpha[0] + (alpha[1] - alpha[0])*index;

        return rgba
    })


    /*
     * map increasing linear values between indicies to
     * linear steps in colorvalues
     */
    var colors = []
    for (i = 0; i < indicies.length-1; ++i) {
        nsteps = indicies[i+1] - indicies[i];
        fromrgba = steps[i];
        torgba = steps[i+1];

        for (var j = 0; j < nsteps; j++) {
            var amt = j / nsteps
            colors.push([
                Math.round(lerp(fromrgba[0], torgba[0], amt)),
                Math.round(lerp(fromrgba[1], torgba[1], amt)),
                Math.round(lerp(fromrgba[2], torgba[2], amt)),
                lerp(fromrgba[3], torgba[3], amt)
            ])
        }
    }

    //add 1 step as last value
    colors.push(cmap[cmap.length - 1].rgb.concat(alpha[1]))

    if (format === 'hex') colors = colors.map( rgb2hex );
    else if (format === 'rgbaString') colors = colors.map( rgbaStr );
    else if (format === 'float') colors = colors.map( rgb2float );

    return colors;
};

function rgb2float (rgba) {
    return [
        rgba[0] / 255,
        rgba[1] / 255,
        rgba[2] / 255,
        rgba[3]
    ]
}

function rgb2hex (rgba) {
    var dig, hex = '#';
    for (var i = 0; i < 3; ++i) {
        dig = rgba[i];
        dig = dig.toString(16);
        hex += ('00' + dig).substr( dig.length );
    }
    return hex;
}

function rgbaStr (rgba) {
    return 'rgba(' + rgba.join(',') + ')';
}

},{"./colorScale":21,"lerp":47}],23:[function(require,module,exports){
module.exports = function gainToDecibels(value) {
  if (value == null) return 0
  return Math.round(Math.round(20 * (0.43429 * Math.log(value)) * 100) / 100 * 10) / 10
}

},{}],24:[function(require,module,exports){
module.exports = {
  fromGain: require('./from-gain'),
  toGain: require('./to-gain')
}

},{"./from-gain":23,"./to-gain":25}],25:[function(require,module,exports){
module.exports = function decibelsToGain(value){
  if (value <= -40){
    return 0
  }
  return Math.round(Math.exp(value / 8.6858) * 10000) / 10000
}

},{}],26:[function(require,module,exports){
module.exports = getSize

function getSize(element) {
  // Handle cases where the element is not already
  // attached to the DOM by briefly appending it
  // to document.body, and removing it again later.
  if (element === window || element === document.body) {
    return [window.innerWidth, window.innerHeight]
  }

  if (!element.parentNode) {
    var temporary = true
    document.body.appendChild(element)
  }

  var bounds = element.getBoundingClientRect()
  var styles = getComputedStyle(element)
  var height = (bounds.height|0)
    + parse(styles.getPropertyValue('margin-top'))
    + parse(styles.getPropertyValue('margin-bottom'))
  var width  = (bounds.width|0)
    + parse(styles.getPropertyValue('margin-left'))
    + parse(styles.getPropertyValue('margin-right'))

  if (temporary) {
    document.body.removeChild(element)
  }

  return [width, height]
}

function parse(prop) {
  return parseFloat(prop) || 0
}

},{}],27:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var this$1 = this;

  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this$1, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var this$1 = this;

  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this$1.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this$1.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],28:[function(require,module,exports){
module.exports = function flatten(list, depth) {
  depth = (typeof depth == 'number') ? depth : Infinity;

  if (!depth) {
    if (Array.isArray(list)) {
      return list.map(function(i) { return i; });
    }
    return list;
  }

  return _flatten(list, 1);

  function _flatten(list, d) {
    return list.reduce(function (acc, item) {
      if (Array.isArray(item) && d < depth) {
        return acc.concat(_flatten(item, d + 1));
      }
      else {
        return acc.concat(item);
      }
    }, []);
  }
};

},{}],29:[function(require,module,exports){
var isFunction = require('is-function')

module.exports = forEach

var toString = Object.prototype.toString
var hasOwnProperty = Object.prototype.hasOwnProperty

function forEach(list, iterator, context) {
    if (!isFunction(iterator)) {
        throw new TypeError('iterator must be a function')
    }

    if (arguments.length < 3) {
        context = this
    }
    
    if (toString.call(list) === '[object Array]')
        forEachArray(list, iterator, context)
    else if (typeof list === 'string')
        forEachString(list, iterator, context)
    else
        forEachObject(list, iterator, context)
}

function forEachArray(array, iterator, context) {
    for (var i = 0, len = array.length; i < len; i++) {
        if (hasOwnProperty.call(array, i)) {
            iterator.call(context, array[i], i, array)
        }
    }
}

function forEachString(string, iterator, context) {
    for (var i = 0, len = string.length; i < len; i++) {
        // no such thing as a sparse string.
        iterator.call(context, string.charAt(i), i, string)
    }
}

function forEachObject(object, iterator, context) {
    for (var k in object) {
        if (hasOwnProperty.call(object, k)) {
            iterator.call(context, object[k], k, object)
        }
    }
}

},{"is-function":42}],30:[function(require,module,exports){
/**
 * Real values fourier transform.
 *
 * @module  fourier-transform
 *
 */
'use strict'

module.exports = function rfft (input, spectrum) {
	if (!input) throw Error("Input waveform is not provided, pass input array.")

	var N = input.length

	var k = Math.floor(Math.log(N) / Math.LN2)

	if (Math.pow(2, k) !== N) throw Error("Invalid array size, must be a power of 2.")

	if (!spectrum) spectrum = new Array(N/2)

	//.forward call
	var n         = N,
		x         = new Array(N),
		TWO_PI    = 2*Math.PI,
		sqrt      = Math.sqrt,
		i         = n >>> 1,
		bSi       = 2 / n,
		n2, n4, n8, nn,
		t1, t2, t3, t4,
		i1, i2, i3, i4, i5, i6, i7, i8,
		st1, cc1, ss1, cc3, ss3,
		e,
		a,
		rval, ival, mag

	reverseBinPermute(N, x, input)

	for (var ix = 0, id = 4; ix < n; id *= 4) {
		for (var i0 = ix; i0 < n; i0 += id) {
			//sumdiff(x[i0], x[i0+1]) // {a, b}  <--| {a+b, a-b}
			st1 = x[i0] - x[i0+1]
			x[i0] += x[i0+1]
			x[i0+1] = st1
		}
		ix = 2*(id-1)
	}

	n2 = 2
	nn = n >>> 1

	while((nn = nn >>> 1)) {
		ix = 0
		n2 = n2 << 1
		id = n2 << 1
		n4 = n2 >>> 2
		n8 = n2 >>> 3
		do {
			if(n4 !== 1) {
				for(i0 = ix; i0 < n; i0 += id) {
					i1 = i0
					i2 = i1 + n4
					i3 = i2 + n4
					i4 = i3 + n4

					//diffsum3_r(x[i3], x[i4], t1) // {a, b, s} <--| {a, b-a, a+b}
					t1 = x[i3] + x[i4]
					x[i4] -= x[i3]
					//sumdiff3(x[i1], t1, x[i3])   // {a, b, d} <--| {a+b, b, a-b}
					x[i3] = x[i1] - t1
					x[i1] += t1

					i1 += n8
					i2 += n8
					i3 += n8
					i4 += n8

					//sumdiff(x[i3], x[i4], t1, t2) // {s, d}  <--| {a+b, a-b}
					t1 = x[i3] + x[i4]
					t2 = x[i3] - x[i4]

					t1 = -t1 * Math.SQRT1_2
					t2 *= Math.SQRT1_2

					// sumdiff(t1, x[i2], x[i4], x[i3]) // {s, d}  <--| {a+b, a-b}
					st1 = x[i2]
					x[i4] = t1 + st1
					x[i3] = t1 - st1

					//sumdiff3(x[i1], t2, x[i2]) // {a, b, d} <--| {a+b, b, a-b}
					x[i2] = x[i1] - t2
					x[i1] += t2
				}
			} else {
				for(i0 = ix; i0 < n; i0 += id) {
					i1 = i0
					i2 = i1 + n4
					i3 = i2 + n4
					i4 = i3 + n4

					//diffsum3_r(x[i3], x[i4], t1) // {a, b, s} <--| {a, b-a, a+b}
					t1 = x[i3] + x[i4]
					x[i4] -= x[i3]

					//sumdiff3(x[i1], t1, x[i3])   // {a, b, d} <--| {a+b, b, a-b}
					x[i3] = x[i1] - t1
					x[i1] += t1
				}
			}

			ix = (id << 1) - n2
			id = id << 2
		} while (ix < n)

		e = TWO_PI / n2

		for (var j = 1; j < n8; j++) {
			a = j * e
			ss1 = Math.sin(a)
			cc1 = Math.cos(a)

			//ss3 = sin(3*a) cc3 = cos(3*a)
			cc3 = 4*cc1*(cc1*cc1-0.75)
			ss3 = 4*ss1*(0.75-ss1*ss1)

			ix = 0; id = n2 << 1
			do {
				for (i0 = ix; i0 < n; i0 += id) {
					i1 = i0 + j
					i2 = i1 + n4
					i3 = i2 + n4
					i4 = i3 + n4

					i5 = i0 + n4 - j
					i6 = i5 + n4
					i7 = i6 + n4
					i8 = i7 + n4

					//cmult(c, s, x, y, &u, &v)
					//cmult(cc1, ss1, x[i7], x[i3], t2, t1) // {u,v} <--| {x*c-y*s, x*s+y*c}
					t2 = x[i7]*cc1 - x[i3]*ss1
					t1 = x[i7]*ss1 + x[i3]*cc1

					//cmult(cc3, ss3, x[i8], x[i4], t4, t3)
					t4 = x[i8]*cc3 - x[i4]*ss3
					t3 = x[i8]*ss3 + x[i4]*cc3

					//sumdiff(t2, t4)   // {a, b} <--| {a+b, a-b}
					st1 = t2 - t4
					t2 += t4
					t4 = st1

					//sumdiff(t2, x[i6], x[i8], x[i3]) // {s, d}  <--| {a+b, a-b}
					//st1 = x[i6] x[i8] = t2 + st1 x[i3] = t2 - st1
					x[i8] = t2 + x[i6]
					x[i3] = t2 - x[i6]

					//sumdiff_r(t1, t3) // {a, b} <--| {a+b, b-a}
					st1 = t3 - t1
					t1 += t3
					t3 = st1

					//sumdiff(t3, x[i2], x[i4], x[i7]) // {s, d}  <--| {a+b, a-b}
					//st1 = x[i2] x[i4] = t3 + st1 x[i7] = t3 - st1
					x[i4] = t3 + x[i2]
					x[i7] = t3 - x[i2]

					//sumdiff3(x[i1], t1, x[i6])   // {a, b, d} <--| {a+b, b, a-b}
					x[i6] = x[i1] - t1
					x[i1] += t1

					//diffsum3_r(t4, x[i5], x[i2]) // {a, b, s} <--| {a, b-a, a+b}
					x[i2] = t4 + x[i5]
					x[i5] -= t4
				}

				ix = (id << 1) - n2
				id = id << 2

			} while (ix < n)
		}
	}

	while (--i) {
		rval = x[i]
		ival = x[n-i-1]
		mag = bSi * sqrt(rval * rval + ival * ival)
		spectrum[i] = mag
	}

	spectrum[0] = Math.abs(bSi * x[0])

	return spectrum
}


function reverseBinPermute (N, dest, source) {
	var halfSize    = N >>> 1,
		nm1         = N - 1,
		i = 1, r = 0, h

	dest[0] = source[0]

	do {
		r += halfSize
		dest[i] = source[r]
		dest[r] = source[i]

		i++

		h = halfSize << 1

		while (h = h >> 1, !((r ^= h) & h)) {}

		if (r >= i) {
			dest[i]     = source[r]
			dest[r]     = source[i]

			dest[nm1-i] = source[nm1-r]
			dest[nm1-r] = source[nm1-i]
		}
		i++
	} while (i < halfSize)

	dest[nm1] = source[nm1]
}
},{}],31:[function(require,module,exports){
module.exports = getCanvasContext
function getCanvasContext (type, opts) {
  if (typeof type !== 'string') {
    throw new TypeError('must specify type string')
  }

  opts = opts || {}

  if (typeof document === 'undefined' && !opts.canvas) {
    return null // check for Node
  }

  var canvas = opts.canvas || document.createElement('canvas')
  if (typeof opts.width === 'number') {
    canvas.width = opts.width
  }
  if (typeof opts.height === 'number') {
    canvas.height = opts.height
  }

  var attribs = opts
  var gl
  try {
    var names = [ type ]
    // prefix GL contexts
    if (type.indexOf('webgl') === 0) {
      names.push('experimental-' + type)
    }

    for (var i = 0; i < names.length; i++) {
      gl = canvas.getContext(names[i], attribs)
      if (gl) return gl
    }
  } catch (e) {
    gl = null
  }
  return (gl || null) // ensure null on fail
}

},{}],32:[function(require,module,exports){
(function (global){
"use strict";

if (global.AnalyserNode && !global.AnalyserNode.prototype.getFloatTimeDomainData) {
  var uint8 = new Uint8Array(2048);
  global.AnalyserNode.prototype.getFloatTimeDomainData = function(array) {
    this.getByteTimeDomainData(uint8);
    for (var i = 0, imax = array.length; i < imax; i++) {
      array[i] = (uint8[i] - 128) * 0.0078125;
    }
  };
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],33:[function(require,module,exports){
/** generate unique id for selector */
var counter = Date.now() % 1e9;

module.exports = function getUid(){
	return (Math.random() * 1e9 >>> 0) + (counter++);
};

},{}],34:[function(require,module,exports){
/**
 * @module  gl-spectrum
 */
'use strict';

var extend = require('xtend/mutable');
var getContext = require('get-canvas-context');
var fit = require('canvas-fit');
var loop = require('raf-loop');
var raf = require('raf');
var isBrowser = require('is-browser');
var Emitter = require('events').EventEmitter;
var inherits = require('inherits');
var isPlainObject = require('is-plain-obj');

module.exports = Component;


//per-context cache of texture/attributes
var texturesCache = new WeakMap();
var attributesCache = new WeakMap();


/**
 * @contructor
 */
function Component (options) {
	var this$1 = this;

	if (!(this instanceof Component)) return new Component(options);

	if (options instanceof Function) {
		options = {
			draw: options
		}
	}

	extend(this, options);

	//preserve initial viewport argument
	this.initialViewport = this.viewport;

	if (typeof this.context === 'string') {
		this.context = getContext(this.context);
	}
	else if (isPlainObject(this.context)) {
		this.context = getContext((this.is2d || this.context.is2d || this.context['2d']) ? '2d' : (this.context.type || 'webgl'), this.context);
	}

	this.canvas = this.context.canvas;

	//null-container means background renderer, so only undefined is recognized as default
	if (this.container === undefined) {
		this.container = this.canvas.parentNode || (isBrowser ? document.body || document.documentElement : {});
		this.container.appendChild(this.canvas);
	}

	this.is2d = !this.context.drawingBufferHeight;
	var gl = this.gl = this.context;

	//cache of textures/attributes
	this.textures = this.textures || {};
	this.attributes = extend({position: [-1,-1, -1,4, 4,-1]}, this.attributes);

	//setup webgl context
	if (!this.is2d) {
		if (this.float) {
			var float = gl.getExtension('OES_texture_float');
			if (!float) {
				var float = gl.getExtension('OES_texture_half_float');
				if (!float) {
					throw Error('WebGL does not support floats.');
				}
				var floatLinear = gl.getExtension('OES_texture_half_float_linear');
			}
			else {
				var floatLinear = gl.getExtension('OES_texture_float_linear');

			}
			if (!floatLinear) throw Error('WebGL does not support floats.');
		}

		this.program = this.createProgram(this.vert, this.frag);

		//preset passed attributes
		this.setAttribute(this.attributes);

		gl.linkProgram(this.program);

		//stub textures with empty data (to avoid errors)
		if (this.autoinitTextures) {
			var numUniforms = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
			for(var i=0; i<numUniforms; ++i) {
				var info = gl.getActiveUniform(this$1.program, i);
				if (info && info.type === gl.SAMPLER_2D) {
					if (!this$1.textures[info.name]) {
						this$1.textures[info.name] = null
					}
				}
			}
		}
		//preset textures
		this.setTexture(this.textures);

		this.viewportLocation = gl.getUniformLocation(this.program, 'viewport');
	}

	//set canvas fit container size
	if (isBrowser) {
		this.fit = fit(this.canvas, this.container);
		this.resize = this.resize.bind(this);

		this.resize();
		window.addEventListener('resize', this.resize, false);
	}


	//create raf loop
	this.engine = loop(function (dt) { return this$1.render(); });
	this.autostart && this.start();
}


inherits(Component, Emitter);


/**
 * Create and use webgl or 2d context
 */
Component.prototype.context = {
	antialias: false,
	alpha: true,
	premultipliedAlpha: true
};

//start rendering cycle on raf automatically
Component.prototype.autostart = true;

Component.prototype.vert = "\n\tattribute vec2 position;\n\tvoid main () {\n\t\tgl_Position = vec4(position, 0, 1);\n\t}\n";


Component.prototype.frag = "\n\tprecision mediump float;\n\tuniform vec4 viewport;\n\tvoid main () {\n\t\tgl_FragColor = vec4(gl_FragCoord.xy / viewport.zw, 1, 1);\n\t}\n";


//enable floating-point textures
Component.prototype.float = false;


//autoinit textures prevents errors in expense of extra-texture call
Component.prototype.autoinitTextures = true;


/**
 * Set texture
 */
Component.prototype.setTexture = function (a, b) {
	var this$1 = this;

	if (this.is2d) return this;

	if (arguments.length === 2 || typeof a === 'string') {
		var opts = {};
		opts[typeof a === 'string' ? a : ''] = b;
	}
	else {
		var opts = a || {};
	}

	var gl = this.context;

	gl.useProgram(this.program);

	for (var name in opts) {
		var obj = this$1.textures[name];

		if (obj && !isPlainObject(obj)) {
			obj = this$1.textures[name] = {name: name, data: obj};
		}
		//if no object - create and bind texture
		else if (!obj) {
			obj = {name: name};

			//if texture name is passed - save obj
			if (name) {
				this$1.textures[name] = obj;
			}
		}

		//check if passed some data/image-like object for the texture or settings object
		var opt = isPlainObject(opts[name]) ? opts[name] : {data: opts[name]};

		if (!obj.name) obj.name = name;

		if (!obj.location && name) {
			obj.location = gl.getUniformLocation(this$1.program, name);
		}

		if (obj.name && obj.unit == null || opt.unit != null) {
			var textureCount = texturesCache.get(this$1.context) || 0;
			obj.unit = opt.unit != null ? opt.unit : textureCount++;
			textureCount = Math.max(textureCount, obj.unit);
			texturesCache.set(this$1.context, textureCount);
			obj.location && gl.uniform1i(obj.location, obj.unit);
		}

		if (!obj.texture) {
			obj.texture = gl.createTexture();
		}

		gl.activeTexture(gl.TEXTURE0 + obj.unit);
		gl.bindTexture(gl.TEXTURE_2D, obj.texture);

		if (opt.wrap || opt.wrapS || !obj.wrapS) {
			obj.wrapS = opt.wrap && opt.wrap[0] || opt.wrapS || opt.wrap || obj.wrapS || gl.REPEAT;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, obj.wrapS);
		}

		if (opt.wrap || opt.wrapT || !obj.wrapT) {
			obj.wrapT = opt.wrap && opt.wrap[1] || opt.wrapT || opt.wrap || obj.wrapT || gl.REPEAT;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, obj.wrapT);
		}

		if (opt.filter || opt.minFilter || !obj.minFilter) {
			obj.minFilter = opt.minFilter || opt.filter || obj.minFilter || gl.NEAREST;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, obj.minFilter);
		}

		if (opt.filter || opt.magFilter || !obj.magFilter) {
			obj.magFilter = opt.magFilter || opt.filter || obj.magFilter || gl.NEAREST;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, obj.magFilter);
		}

		if (!obj.type || opt.type) {
			obj.type = opt.type || obj.type || (this$1.float ? gl.FLOAT : gl.UNSIGNED_BYTE);
		}

		if (!obj.format || opt.format) {
			obj.format = opt.format || obj.format || gl.RGBA;
		}


		var data = opt.data || null;
		if (isBrowser) {
			if (typeof data === 'string') {
				if (data === (obj.data && obj.data._src) || data === (obj.data && obj.data.src)) {
					return this$1;
				}
				var image = new Image;
				image.src = data;
				image._src = data;
			}
			else if (data instanceof Image && !data.complete) {
				var image = data;
			}

			if (image) {
				if (image.complete && image === obj.data || image.src === obj.data.src) {
					return this$1;
				}
				image.addEventListener('load', function () {
					this$1.setTexture(obj.name || obj.texture, image)
				});
				data = null;
			}
		}

		//handle raw data case
		if (data == null || Array.isArray(data) || ArrayBuffer.isView(data)) {
			if (opt && opt.shape) {
				obj.width = opt.shape[0];
				obj.height = opt.shape[1];
			}
			else {
				var len = data && data.length || 1;
				obj.width = opt.width || data && data.width || (obj.format === gl.ALPHA ? len : Math.max(len / 4, 1));
				obj.height = opt.height || (data && data.height) || 1;
			}
			obj.data = data == null ? null : obj.type === gl.FLOAT ? new Float32Array(data) : obj.type === gl.UNSIGNED_SHORT ? new Uint16Array(data) : new Uint8Array(data);

			gl.texImage2D(gl.TEXTURE_2D, 0, obj.format, obj.width, obj.height, 0, obj.format, obj.type, obj.data);
		} else {
			obj.width = data && data.width || 1;
			obj.height = data && data.height || 1;
			obj.data = data;
			gl.texImage2D(gl.TEXTURE_2D, 0, obj.format, obj.format, obj.type, obj.data);
		}
	}

	return this;
};



//create and set buffer
Component.prototype.setAttribute = function (a, b) {
	var this$1 = this;

	if (this.is2d) return this;

	if (arguments.length === 2 || typeof a === 'string') {
		var opts = {};
		opts[a] = b;
	}
	else {
		var opts = a || {position: [-1,-1, -1,4, 4,-1]};
	}

	var gl = this.context;

	gl.useProgram(this.program);

	for (var name in opts) {
		var obj = this$1.attributes[name];
		if (obj && !isPlainObject(obj)) {
			obj = this$1.attributes[name] = {name: name, data: obj};
		}
		else if (obj && obj.data === opts[name]) {
			continue;
		}

		//if object exists and ony the data passed - just update buffer data
		if (obj) {
			if (opts[name] && obj.data && !isPlainObject(opts[name]) && opts[name].length <= obj.data.length) {
				if (obj.target === gl.ELEMENT_ARRAY_BUFFER) {
					obj.data = new Uint16Array(opts[name]);
				}
				else if (obj.type === gl.FLOAT) {
					obj.data = new Float32Array(opts[name]);
				}
				else if (obj.type === gl.UNSIGNED_BYTE) {
					obj.data = new Uint8Array(opts[name]);
				}

				gl.bufferSubData(obj.target, 0, obj.data);
				return this$1;
			}
		}
		//if no object - create and bind texture
		else {
			obj = this$1.attributes[name] = {name: name};
		}

		if (!obj.name) obj.name = name;

		//check if passed some data/image-like object for the texture or settings object
		var opt = isPlainObject(opts[name]) ? opts[name] : {data: opts[name]};

		extend(obj, opt);

		if (!obj.target) {
			obj.target = gl.ARRAY_BUFFER;
		}

		if (!obj.data) {
			obj.data = [-1,-1,-1,4,4,-1]
		}

		if (!obj.buffer) {
			obj.buffer = gl.createBuffer();
		}

		if (!obj.usage) {
			obj.usage = gl.STATIC_DRAW;
		}

		if (obj.index == null) {
			var attrCount = attributesCache.get(this$1.context) || 0;
			obj.index = attrCount++;
			attrCount = Math.max(attrCount, obj.index);
			attributesCache.set(this$1.context, attrCount);
		}

		if (!obj.size) {
			obj.size = 2;
		}

		if (!obj.type) {
			obj.type = obj.target === gl.ELEMENT_ARRAY_BUFFER ? gl.UNSIGNED_SHORT : gl.FLOAT;
		}

		if (obj.type === gl.FLOAT) {
			obj.data = new Float32Array(obj.data);
		}
		else if (obj.type === gl.UNSIGNED_BYTE) {
			obj.data = new Uint8Array(obj.data);
		}
		else if (obj.type === gl.UNSIGNED_SHORT) {
			obj.data =  new Uint16Array(obj.data);
		}

		if (obj.normalized == null) {
			obj.normalized = false;
		}

		if (obj.stride == null) {
			obj.stride = 0;
		}

		if (obj.offset == null) {
			obj.offset = 0;
		}

		gl.bindBuffer(obj.target, obj.buffer);
		gl.bufferData(obj.target, obj.data, obj.usage);
		gl.enableVertexAttribArray(obj.index);
		gl.vertexAttribPointer(obj.index, obj.size, obj.type, obj.normalized, obj.stride, obj.offset);
		gl.bindAttribLocation(this$1.program, obj.index, obj.name);
	}

	return this;
}



/**
 * Do resize routine
 */
Component.prototype.resize = function () {
	this.fit();

	this.updateViewport();

	this.emit('resize');

	return this;
};

Component.prototype.updateViewport = function () {
	var gl = this.context;
	var w = this.canvas.width, h = this.canvas.height;

	//if vp is undefined - set it as full-height
	if (!this.initialViewport) {
		this.viewport = [0, 0, w, h];
	}
	else if (this.initialViewport instanceof Function) {
		this.viewport = this.initialViewport(w, h);
	}
	else {
		this.viewport = this.initialViewport;
	}

	if (!this.is2d) {
		//this trickery inverts viewport Y
		var top = h-(this.viewport[3]+this.viewport[1]);
		this.glViewport = [this.viewport[0], top, this.viewport[2], this.viewport[3] + Math.min(top, 0)];
		gl.useProgram(this.program);
		gl.uniform4fv(this.viewportLocation, this.glViewport);
	}

	return this;
}

/**
 * Stop rendering loop
 */
Component.prototype.stop = function () {
	this.engine.stop();
	return this;
};
Component.prototype.start = function () {
	this.engine.start();
	return this;
};


/**
 * Render main loop
 */
Component.prototype.render = function (data) {
	var this$1 = this;

	var gl = this.context;

	if (!this.is2d) {
		//save viewport
		// var viewport = gl.getParameter(gl.VIEWPORT);

		gl.viewport.apply(gl, this.glViewport);

		// gl.viewport.apply(gl, viewport);
	}

	this.emit('render', data);

	//manual rendering should not be more frequent than raf
	//though the actual data is the last one
	if (!this.autostart) {
		if (this._planned) {
			if (data != null) this._planned = data;
			return this;
		}
		this._planned = data == null ? true : data;
		raf(function () {
			var data = this$1._planned;
			this$1._planned = null;
			this$1.draw(data)
		});
	} else {
		this.draw(data);
	}

	return this;
};

/**
 * A specific way to draw data.
 */
Component.prototype.draw = function (data) {

	if (this.is2d) return this;

	this.gl.useProgram(this.program);
	//Q: how should we organize drawArrays method?
	//1. we may want to avoid calling it - how?
	//2. we may want to change draw mode
	//3. we may want to draw a specific subset of data
	//a. place everything to event loop, cept this method
	//   - that disables outside `.render` invocation
	//b. provide `.drawMode` param
	//   - that is a bad pattern (diff to remember, god object, too declarative)
	//   - still unable to cancel invocation
	//c. how about a separate `.draw` method?
	//   - a bit of a headache for users to discern render and draw
	//   + though pattern is simple: .render for call, not overriding, draw is for redefinition, not call. Also draw may take params.
	this.gl.drawArrays(this.gl.TRIANGLES, 0, this.attributes.position.data.length / this.attributes.position.size);

	return this;
}


//create program (2 shaders)
Component.prototype.createProgram = function (vSrc, fSrc) {
	if (this.is2d) return null;

	var gl = this.gl;

	var fShader = gl.createShader(gl.FRAGMENT_SHADER);
	var vShader = gl.createShader(gl.VERTEX_SHADER);

	gl.shaderSource(fShader, fSrc);
	gl.shaderSource(vShader, vSrc);

	gl.compileShader(fShader);

	if (!gl.getShaderParameter(fShader, gl.COMPILE_STATUS)) {
		console.error(gl.getShaderInfoLog(fShader));
	}

	gl.compileShader(vShader);

	if (!gl.getShaderParameter(vShader, gl.COMPILE_STATUS)) {
		console.error(gl.getShaderInfoLog(vShader));
	}


	var program = gl.createProgram();
	gl.attachShader(program, vShader);
	gl.attachShader(program, fShader);
	gl.linkProgram(program);

	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		console.error(gl.getProgramInfoLog(program));
	}

	gl.useProgram(program);

	return program;
}
},{"canvas-fit":16,"events":27,"get-canvas-context":31,"inherits":37,"is-browser":40,"is-plain-obj":44,"raf":65,"raf-loop":64,"xtend/mutable":82}],35:[function(require,module,exports){
(function (global){
if (typeof window !== "undefined") {
    module.exports = window;
} else if (typeof global !== "undefined") {
    module.exports = global;
} else {
    module.exports = {};
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],36:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],37:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],38:[function(require,module,exports){
var containers = []; // will store container HTMLElement references
var styleElements = []; // will store {prepend: HTMLElement, append: HTMLElement}

function insertCss(css, options) {
    options = options || {};

    var position = options.prepend === true ? 'prepend' : 'append';
    var container = options.container !== undefined ? options.container : document.querySelector('head');
    var containerId = containers.indexOf(container);

    // first time we see this container, create the necessary entries
    if (containerId === -1) {
        containerId = containers.push(container) - 1;
        styleElements[containerId] = {};
    }

    // try to get the correponding container + position styleElement, create it otherwise
    var styleElement;

    if (styleElements[containerId] !== undefined && styleElements[containerId][position] !== undefined) {
        styleElement = styleElements[containerId][position];
    } else {
        styleElement = styleElements[containerId][position] = createStyleElement();

        if (position === 'prepend') {
            container.insertBefore(styleElement, container.childNodes[0]);
        } else {
            container.appendChild(styleElement);
        }
    }

    // strip potential UTF-8 BOM if css was read from a file
    if (css.charCodeAt(0) === 0xFEFF) { css = css.substr(1, css.length); }

    // actually add the stylesheet
    if (styleElement.styleSheet) {
        styleElement.styleSheet.cssText += css
    } else {
        styleElement.textContent += css;
    }

    return styleElement;
};

function createStyleElement() {
    var styleElement = document.createElement('style');
    styleElement.setAttribute('type', 'text/css');
    return styleElement;
}

module.exports = insertCss;
module.exports.insertCss = insertCss;

},{}],39:[function(require,module,exports){
(function (global){
'use strict'

var cache = {}

function noop () {}

module.exports = !global.document ? noop : insertStyles

function insertStyles (styles, options) {
  var id = options && options.id || styles

  var element = cache[id] = (cache[id] || createStyle(id))

  if ('textContent' in element) {
    element.textContent = styles
  } else {
    element.styleSheet.cssText = styles
  }
}

function createStyle (id) {
  var element = document.getElementById(id)

  if (element) return element

  element = document.createElement('style')
  element.setAttribute('type', 'text/css')

  document.head.appendChild(element)

  return element
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],40:[function(require,module,exports){
module.exports = true;

},{}],41:[function(require,module,exports){
module.exports = isNode

function isNode (val) {
  return (!val || typeof val !== 'object')
    ? false
    : (typeof window === 'object' && typeof window.Node === 'object')
      ? (val instanceof window.Node)
      : (typeof val.nodeType === 'number') &&
        (typeof val.nodeName === 'string')
}

},{}],42:[function(require,module,exports){
module.exports = isFunction

var toString = Object.prototype.toString

function isFunction (fn) {
  var string = toString.call(fn)
  return string === '[object Function]' ||
    (typeof fn === 'function' && string !== '[object RegExp]') ||
    (typeof window !== 'undefined' &&
     // IE8 and below
     (fn === window.setTimeout ||
      fn === window.alert ||
      fn === window.confirm ||
      fn === window.prompt))
};

},{}],43:[function(require,module,exports){
module.exports = isMobile;

function isMobile (ua) {
  if (!ua && typeof navigator != 'undefined') ua = navigator.userAgent;
  if (ua && ua.headers && typeof ua.headers['user-agent'] == 'string') {
    ua = ua.headers['user-agent'];
  }
  if (typeof ua != 'string') return false;

  return /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino/i.test(ua) || /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(ua.substr(0,4));
}

},{}],44:[function(require,module,exports){
'use strict';
var toString = Object.prototype.toString;

module.exports = function (x) {
	var prototype;
	return toString.call(x) === '[object Object]' && (prototype = Object.getPrototypeOf(x), prototype === null || prototype === Object.getPrototypeOf({}));
};

},{}],45:[function(require,module,exports){

/**
 * Expose `isUrl`.
 */

module.exports = isUrl;

/**
 * Matcher.
 */

var matcher = /^(?:\w+:)?\/\/([^\s\.]+\.\S{2}|localhost[\:?\d]*)\S*$/;

/**
 * Loosely validate a URL `string`.
 *
 * @param {String} string
 * @return {Boolean}
 */

function isUrl(string){
  return matcher.test(string);
}

},{}],46:[function(require,module,exports){
/* This program is free software. It comes without any warranty, to
     * the extent permitted by applicable law. You can redistribute it
     * and/or modify it under the terms of the Do What The Fuck You Want
     * To Public License, Version 2, as published by Sam Hocevar. See
     * http://www.wtfpl.net/ for more details. */
'use strict';
module.exports = leftPad;

var cache = [
  '',
  ' ',
  '  ',
  '   ',
  '    ',
  '     ',
  '      ',
  '       ',
  '        ',
  '         '
];

function leftPad (str, len, ch) {
  // convert `str` to `string`
  str = str + '';
  // `len` is the `pad`'s length now
  len = len - str.length;
  // doesn't need to pad
  if (len <= 0) return str;
  // `ch` defaults to `' '`
  if (!ch && ch !== 0) ch = ' ';
  // convert `ch` to `string`
  ch = ch + '';
  // cache common use cases
  if (ch === ' ' && len < 10) return cache[len] + str;
  // `pad` starts with an empty string
  var pad = '';
  // loop
  while (true) {
    // add `ch` to `pad` if `len` is odd
    if (len & 1) pad += ch;
    // divide `len` by 2, ditch the remainder
    len >>= 1;
    // "double" the `ch` so this operation count grows logarithmically on `len`
    // each time `ch` is "doubled", the `len` would need to be "doubled" too
    // similar to finding a value in binary search tree, hence O(log(n))
    if (len) ch += ch;
    // `len` is 0, exit the loop
    else break;
  }
  // pad `str`!
  return pad + str;
}

},{}],47:[function(require,module,exports){
function lerp(v0, v1, t) {
    return v0*(1-t)+v1*t
}
module.exports = lerp

},{}],48:[function(require,module,exports){
/**
 * Clamp value.
 * Detects proper clamp min/max.
 *
 * @param {number} a Current value to cut off
 * @param {number} min One side limit
 * @param {number} max Other side limit
 *
 * @return {number} Clamped value
 */

module.exports = require('./wrap')(function(a, min, max){
	return max > min ? Math.max(Math.min(a,max),min) : Math.max(Math.min(a,min),max);
});

},{"./wrap":50}],49:[function(require,module,exports){
/**
 * Base 10 logarithm
 *
 * @module mumath/lg
 */
module.exports = require('./wrap')(function (a) {
	return Math.log(a) / Math.log(10);
});

},{"./wrap":50}],50:[function(require,module,exports){
/**
 * Get fn wrapped with array/object attrs recognition
 *
 * @return {Function} Target function
 */
module.exports = function(fn){
	return function (a) {
		var this$1 = this;

		var args = arguments;
		if (a instanceof Array) {
			var result = new Array(a.length), slice;
			for (var i = 0; i < a.length; i++){
				slice = [];
				for (var j = 0, l = args.length, val; j < l; j++){
					val = args[j] instanceof Array ? args[j][i] : args[j];
					val = val;
					slice.push(val);
				}
				result[i] = fn.apply(this$1, slice);
			}
			return result;
		}
		else if (typeof a === 'object') {
			var result = {}, slice;
			for (var i in a){
				slice = [];
				for (var j = 0, l = args.length, val; j < l; j++){
					val = typeof args[j] === 'object' ? args[j][i] : args[j];
					val = val;
					slice.push(val);
				}
				result[i] = fn.apply(this$1, slice);
			}
			return result;
		}
		else {
			return fn.apply(this, args);
		}
	};
};

},{}],51:[function(require,module,exports){
/**
 * @module mutype/is-object
 */

//TODO: add st8 tests

//isPlainObject indeed
module.exports = function(o){
	// return obj === Object(obj);
	return !!o && typeof o === 'object' && o.constructor === Object;
};
},{}],52:[function(require,module,exports){
module.exports=[["#69d2e7","#a7dbd8","#e0e4cc","#f38630","#fa6900"],["#fe4365","#fc9d9a","#f9cdad","#c8c8a9","#83af9b"],["#ecd078","#d95b43","#c02942","#542437","#53777a"],["#556270","#4ecdc4","#c7f464","#ff6b6b","#c44d58"],["#774f38","#e08e79","#f1d4af","#ece5ce","#c5e0dc"],["#e8ddcb","#cdb380","#036564","#033649","#031634"],["#490a3d","#bd1550","#e97f02","#f8ca00","#8a9b0f"],["#594f4f","#547980","#45ada8","#9de0ad","#e5fcc2"],["#00a0b0","#6a4a3c","#cc333f","#eb6841","#edc951"],["#e94e77","#d68189","#c6a49a","#c6e5d9","#f4ead5"],["#3fb8af","#7fc7af","#dad8a7","#ff9e9d","#ff3d7f"],["#d9ceb2","#948c75","#d5ded9","#7a6a53","#99b2b7"],["#ffffff","#cbe86b","#f2e9e1","#1c140d","#cbe86b"],["#efffcd","#dce9be","#555152","#2e2633","#99173c"],["#343838","#005f6b","#008c9e","#00b4cc","#00dffc"],["#413e4a","#73626e","#b38184","#f0b49e","#f7e4be"],["#99b898","#fecea8","#ff847c","#e84a5f","#2a363b"],["#ff4e50","#fc913a","#f9d423","#ede574","#e1f5c4"],["#655643","#80bca3","#f6f7bd","#e6ac27","#bf4d28"],["#351330","#424254","#64908a","#e8caa4","#cc2a41"],["#00a8c6","#40c0cb","#f9f2e7","#aee239","#8fbe00"],["#554236","#f77825","#d3ce3d","#f1efa5","#60b99a"],["#ff9900","#424242","#e9e9e9","#bcbcbc","#3299bb"],["#8c2318","#5e8c6a","#88a65e","#bfb35a","#f2c45a"],["#fad089","#ff9c5b","#f5634a","#ed303c","#3b8183"],["#5d4157","#838689","#a8caba","#cad7b2","#ebe3aa"],["#ff4242","#f4fad2","#d4ee5e","#e1edb9","#f0f2eb"],["#d1e751","#ffffff","#000000","#4dbce9","#26ade4"],["#f8b195","#f67280","#c06c84","#6c5b7b","#355c7d"],["#bcbdac","#cfbe27","#f27435","#f02475","#3b2d38"],["#5e412f","#fcebb6","#78c0a8","#f07818","#f0a830"],["#1b676b","#519548","#88c425","#bef202","#eafde6"],["#eee6ab","#c5bc8e","#696758","#45484b","#36393b"],["#452632","#91204d","#e4844a","#e8bf56","#e2f7ce"],["#f0d8a8","#3d1c00","#86b8b1","#f2d694","#fa2a00"],["#f04155","#ff823a","#f2f26f","#fff7bd","#95cfb7"],["#2a044a","#0b2e59","#0d6759","#7ab317","#a0c55f"],["#bbbb88","#ccc68d","#eedd99","#eec290","#eeaa88"],["#b9d7d9","#668284","#2a2829","#493736","#7b3b3b"],["#67917a","#170409","#b8af03","#ccbf82","#e33258"],["#a3a948","#edb92e","#f85931","#ce1836","#009989"],["#b3cc57","#ecf081","#ffbe40","#ef746f","#ab3e5b"],["#e8d5b7","#0e2430","#fc3a51","#f5b349","#e8d5b9"],["#ab526b","#bca297","#c5ceae","#f0e2a4","#f4ebc3"],["#607848","#789048","#c0d860","#f0f0d8","#604848"],["#aab3ab","#c4cbb7","#ebefc9","#eee0b7","#e8caaf"],["#300030","#480048","#601848","#c04848","#f07241"],["#a8e6ce","#dcedc2","#ffd3b5","#ffaaa6","#ff8c94"],["#3e4147","#fffedf","#dfba69","#5a2e2e","#2a2c31"],["#515151","#ffffff","#00b4ff","#eeeeee"],["#fc354c","#29221f","#13747d","#0abfbc","#fcf7c5"],["#1c2130","#028f76","#b3e099","#ffeaad","#d14334"],["#b6d8c0","#c8d9bf","#dadabd","#ecdbbc","#fedcba"],["#edebe6","#d6e1c7","#94c7b6","#403b33","#d3643b"],["#fdf1cc","#c6d6b8","#987f69","#e3ad40","#fcd036"],["#cc0c39","#e6781e","#c8cf02","#f8fcc1","#1693a7"],["#5c323e","#a82743","#e15e32","#c0d23e","#e5f04c"],["#dad6ca","#1bb0ce","#4f8699","#6a5e72","#563444"],["#230f2b","#f21d41","#ebebbc","#bce3c5","#82b3ae"],["#b9d3b0","#81bda4","#b28774","#f88f79","#f6aa93"],["#3a111c","#574951","#83988e","#bcdea5","#e6f9bc"],["#a7c5bd","#e5ddcb","#eb7b59","#cf4647","#524656"],["#5e3929","#cd8c52","#b7d1a3","#dee8be","#fcf7d3"],["#1c0113","#6b0103","#a30006","#c21a01","#f03c02"],["#8dccad","#988864","#fea6a2","#f9d6ac","#ffe9af"],["#c1b398","#605951","#fbeec2","#61a6ab","#accec0"],["#382f32","#ffeaf2","#fcd9e5","#fbc5d8","#f1396d"],["#e3dfba","#c8d6bf","#93ccc6","#6cbdb5","#1a1f1e"],["#5e9fa3","#dcd1b4","#fab87f","#f87e7b","#b05574"],["#4e395d","#827085","#8ebe94","#ccfc8e","#dc5b3e"],["#000000","#9f111b","#b11623","#292c37","#cccccc"],["#cfffdd","#b4dec1","#5c5863","#a85163","#ff1f4c"],["#9dc9ac","#fffec7","#f56218","#ff9d2e","#919167"],["#413d3d","#040004","#c8ff00","#fa023c","#4b000f"],["#951f2b","#f5f4d7","#e0dfb1","#a5a36c","#535233"],["#1b325f","#9cc4e4","#e9f2f9","#3a89c9","#f26c4f"],["#a8a7a7","#cc527a","#e8175d","#474747","#363636"],["#eff3cd","#b2d5ba","#61ada0","#248f8d","#605063"],["#2d2d29","#215a6d","#3ca2a2","#92c7a3","#dfece6"],["#ffedbf","#f7803c","#f54828","#2e0d23","#f8e4c1"],["#9d7e79","#ccac95","#9a947c","#748b83","#5b756c"],["#f6f6f6","#e8e8e8","#333333","#990100","#b90504"],["#0ca5b0","#4e3f30","#fefeeb","#f8f4e4","#a5b3aa"],["#edf6ee","#d1c089","#b3204d","#412e28","#151101"],["#d1313d","#e5625c","#f9bf76","#8eb2c5","#615375"],["#fffbb7","#a6f6af","#66b6ab","#5b7c8d","#4f2958"],["#4e4d4a","#353432","#94ba65","#2790b0","#2b4e72"],["#f38a8a","#55443d","#a0cab5","#cde9ca","#f1edd0"],["#a70267","#f10c49","#fb6b41","#f6d86b","#339194"],["#fcfef5","#e9ffe1","#cdcfb7","#d6e6c3","#fafbe3"],["#4d3b3b","#de6262","#ffb88c","#ffd0b3","#f5e0d3"],["#c2412d","#d1aa34","#a7a844","#a46583","#5a1e4a"],["#046d8b","#309292","#2fb8ac","#93a42a","#ecbe13"],["#f8edd1","#d88a8a","#474843","#9d9d93","#c5cfc6"],["#9cddc8","#bfd8ad","#ddd9ab","#f7af63","#633d2e"],["#ffefd3","#fffee4","#d0ecea","#9fd6d2","#8b7a5e"],["#30261c","#403831","#36544f","#1f5f61","#0b8185"],["#75616b","#bfcff7","#dce4f7","#f8f3bf","#d34017"],["#a1dbb2","#fee5ad","#faca66","#f7a541","#f45d4c"],["#ff003c","#ff8a00","#fabe28","#88c100","#00c176"],["#fe4365","#fc9d9a","#f9cdad","#c8c8a9","#83af9b"],["#ecd078","#d95b43","#c02942","#542437","#53777a"],["#556270","#4ecdc4","#c7f464","#ff6b6b","#c44d58"],["#774f38","#e08e79","#f1d4af","#ece5ce","#c5e0dc"],["#e8ddcb","#cdb380","#036564","#033649","#031634"],["#490a3d","#bd1550","#e97f02","#f8ca00","#8a9b0f"],["#594f4f","#547980","#45ada8","#9de0ad","#e5fcc2"],["#00a0b0","#6a4a3c","#cc333f","#eb6841","#edc951"],["#e94e77","#d68189","#c6a49a","#c6e5d9","#f4ead5"],["#3fb8af","#7fc7af","#dad8a7","#ff9e9d","#ff3d7f"],["#d9ceb2","#948c75","#d5ded9","#7a6a53","#99b2b7"],["#ffffff","#cbe86b","#f2e9e1","#1c140d","#cbe86b"],["#efffcd","#dce9be","#555152","#2e2633","#99173c"],["#343838","#005f6b","#008c9e","#00b4cc","#00dffc"],["#413e4a","#73626e","#b38184","#f0b49e","#f7e4be"],["#99b898","#fecea8","#ff847c","#e84a5f","#2a363b"],["#ff4e50","#fc913a","#f9d423","#ede574","#e1f5c4"],["#655643","#80bca3","#f6f7bd","#e6ac27","#bf4d28"],["#351330","#424254","#64908a","#e8caa4","#cc2a41"],["#00a8c6","#40c0cb","#f9f2e7","#aee239","#8fbe00"],["#554236","#f77825","#d3ce3d","#f1efa5","#60b99a"],["#ff9900","#424242","#e9e9e9","#bcbcbc","#3299bb"],["#8c2318","#5e8c6a","#88a65e","#bfb35a","#f2c45a"],["#fad089","#ff9c5b","#f5634a","#ed303c","#3b8183"],["#5d4157","#838689","#a8caba","#cad7b2","#ebe3aa"],["#ff4242","#f4fad2","#d4ee5e","#e1edb9","#f0f2eb"],["#d1e751","#ffffff","#000000","#4dbce9","#26ade4"],["#f8b195","#f67280","#c06c84","#6c5b7b","#355c7d"],["#bcbdac","#cfbe27","#f27435","#f02475","#3b2d38"],["#5e412f","#fcebb6","#78c0a8","#f07818","#f0a830"],["#1b676b","#519548","#88c425","#bef202","#eafde6"],["#eee6ab","#c5bc8e","#696758","#45484b","#36393b"],["#452632","#91204d","#e4844a","#e8bf56","#e2f7ce"],["#f0d8a8","#3d1c00","#86b8b1","#f2d694","#fa2a00"],["#f04155","#ff823a","#f2f26f","#fff7bd","#95cfb7"],["#2a044a","#0b2e59","#0d6759","#7ab317","#a0c55f"],["#bbbb88","#ccc68d","#eedd99","#eec290","#eeaa88"],["#b9d7d9","#668284","#2a2829","#493736","#7b3b3b"],["#67917a","#170409","#b8af03","#ccbf82","#e33258"],["#a3a948","#edb92e","#f85931","#ce1836","#009989"],["#b3cc57","#ecf081","#ffbe40","#ef746f","#ab3e5b"],["#e8d5b7","#0e2430","#fc3a51","#f5b349","#e8d5b9"],["#ab526b","#bca297","#c5ceae","#f0e2a4","#f4ebc3"],["#607848","#789048","#c0d860","#f0f0d8","#604848"],["#aab3ab","#c4cbb7","#ebefc9","#eee0b7","#e8caaf"],["#300030","#480048","#601848","#c04848","#f07241"],["#a8e6ce","#dcedc2","#ffd3b5","#ffaaa6","#ff8c94"],["#3e4147","#fffedf","#dfba69","#5a2e2e","#2a2c31"],["#515151","#ffffff","#00b4ff","#eeeeee"],["#fc354c","#29221f","#13747d","#0abfbc","#fcf7c5"],["#1c2130","#028f76","#b3e099","#ffeaad","#d14334"],["#b6d8c0","#c8d9bf","#dadabd","#ecdbbc","#fedcba"],["#edebe6","#d6e1c7","#94c7b6","#403b33","#d3643b"],["#fdf1cc","#c6d6b8","#987f69","#e3ad40","#fcd036"],["#cc0c39","#e6781e","#c8cf02","#f8fcc1","#1693a7"],["#5c323e","#a82743","#e15e32","#c0d23e","#e5f04c"],["#dad6ca","#1bb0ce","#4f8699","#6a5e72","#563444"],["#230f2b","#f21d41","#ebebbc","#bce3c5","#82b3ae"],["#b9d3b0","#81bda4","#b28774","#f88f79","#f6aa93"],["#3a111c","#574951","#83988e","#bcdea5","#e6f9bc"],["#a7c5bd","#e5ddcb","#eb7b59","#cf4647","#524656"],["#5e3929","#cd8c52","#b7d1a3","#dee8be","#fcf7d3"],["#1c0113","#6b0103","#a30006","#c21a01","#f03c02"],["#8dccad","#988864","#fea6a2","#f9d6ac","#ffe9af"],["#c1b398","#605951","#fbeec2","#61a6ab","#accec0"],["#382f32","#ffeaf2","#fcd9e5","#fbc5d8","#f1396d"],["#e3dfba","#c8d6bf","#93ccc6","#6cbdb5","#1a1f1e"],["#5e9fa3","#dcd1b4","#fab87f","#f87e7b","#b05574"],["#4e395d","#827085","#8ebe94","#ccfc8e","#dc5b3e"],["#000000","#9f111b","#b11623","#292c37","#cccccc"],["#cfffdd","#b4dec1","#5c5863","#a85163","#ff1f4c"],["#9dc9ac","#fffec7","#f56218","#ff9d2e","#919167"],["#413d3d","#040004","#c8ff00","#fa023c","#4b000f"],["#951f2b","#f5f4d7","#e0dfb1","#a5a36c","#535233"],["#1b325f","#9cc4e4","#e9f2f9","#3a89c9","#f26c4f"],["#a8a7a7","#cc527a","#e8175d","#474747","#363636"],["#eff3cd","#b2d5ba","#61ada0","#248f8d","#605063"],["#2d2d29","#215a6d","#3ca2a2","#92c7a3","#dfece6"],["#ffedbf","#f7803c","#f54828","#2e0d23","#f8e4c1"],["#9d7e79","#ccac95","#9a947c","#748b83","#5b756c"],["#f6f6f6","#e8e8e8","#333333","#990100","#b90504"],["#0ca5b0","#4e3f30","#fefeeb","#f8f4e4","#a5b3aa"],["#edf6ee","#d1c089","#b3204d","#412e28","#151101"],["#d1313d","#e5625c","#f9bf76","#8eb2c5","#615375"],["#fffbb7","#a6f6af","#66b6ab","#5b7c8d","#4f2958"],["#4e4d4a","#353432","#94ba65","#2790b0","#2b4e72"],["#f38a8a","#55443d","#a0cab5","#cde9ca","#f1edd0"],["#a70267","#f10c49","#fb6b41","#f6d86b","#339194"],["#fcfef5","#e9ffe1","#cdcfb7","#d6e6c3","#fafbe3"],["#4d3b3b","#de6262","#ffb88c","#ffd0b3","#f5e0d3"],["#c2412d","#d1aa34","#a7a844","#a46583","#5a1e4a"],["#046d8b","#309292","#2fb8ac","#93a42a","#ecbe13"],["#f8edd1","#d88a8a","#474843","#9d9d93","#c5cfc6"],["#9cddc8","#bfd8ad","#ddd9ab","#f7af63","#633d2e"],["#ffefd3","#fffee4","#d0ecea","#9fd6d2","#8b7a5e"],["#30261c","#403831","#36544f","#1f5f61","#0b8185"],["#75616b","#bfcff7","#dce4f7","#f8f3bf","#d34017"],["#a1dbb2","#fee5ad","#faca66","#f7a541","#f45d4c"],["#ff003c","#ff8a00","#fabe28","#88c100","#00c176"],["#aaff00","#ffaa00","#ff00aa","#aa00ff","#00aaff"]]
},{}],53:[function(require,module,exports){
/*
object-assign
(c) Sindre Sorhus
@license MIT
*/

'use strict';
/* eslint-disable no-unused-vars */
var getOwnPropertySymbols = Object.getOwnPropertySymbols;
var hasOwnProperty = Object.prototype.hasOwnProperty;
var propIsEnumerable = Object.prototype.propertyIsEnumerable;

function toObject(val) {
	if (val === null || val === undefined) {
		throw new TypeError('Object.assign cannot be called with null or undefined');
	}

	return Object(val);
}

function shouldUseNative() {
	try {
		if (!Object.assign) {
			return false;
		}

		// Detect buggy property enumeration order in older V8 versions.

		// https://bugs.chromium.org/p/v8/issues/detail?id=4118
		var test1 = new String('abc');  // eslint-disable-line no-new-wrappers
		test1[5] = 'de';
		if (Object.getOwnPropertyNames(test1)[0] === '5') {
			return false;
		}

		// https://bugs.chromium.org/p/v8/issues/detail?id=3056
		var test2 = {};
		for (var i = 0; i < 10; i++) {
			test2['_' + String.fromCharCode(i)] = i;
		}
		var order2 = Object.getOwnPropertyNames(test2).map(function (n) {
			return test2[n];
		});
		if (order2.join('') !== '0123456789') {
			return false;
		}

		// https://bugs.chromium.org/p/v8/issues/detail?id=3056
		var test3 = {};
		'abcdefghijklmnopqrst'.split('').forEach(function (letter) {
			test3[letter] = letter;
		});
		if (Object.keys(Object.assign({}, test3)).join('') !==
				'abcdefghijklmnopqrst') {
			return false;
		}

		return true;
	} catch (err) {
		// We don't expect any of the above to throw, but better to be safe.
		return false;
	}
}

module.exports = shouldUseNative() ? Object.assign : function (target, source) {
	var arguments$1 = arguments;

	var from;
	var to = toObject(target);
	var symbols;

	for (var s = 1; s < arguments.length; s++) {
		from = Object(arguments$1[s]);

		for (var key in from) {
			if (hasOwnProperty.call(from, key)) {
				to[key] = from[key];
			}
		}

		if (getOwnPropertySymbols) {
			symbols = getOwnPropertySymbols(from);
			for (var i = 0; i < symbols.length; i++) {
				if (propIsEnumerable.call(from, symbols[i])) {
					to[symbols[i]] = from[symbols[i]];
				}
			}
		}
	}

	return to;
};

},{}],54:[function(require,module,exports){
var trim = require('trim')
  , forEach = require('for-each')
  , isArray = function(arg) {
      return Object.prototype.toString.call(arg) === '[object Array]';
    }

module.exports = function (headers) {
  if (!headers)
    return {}

  var result = {}

  forEach(
      trim(headers).split('\n')
    , function (row) {
        var index = row.indexOf(':')
          , key = trim(row.slice(0, index)).toLowerCase()
          , value = trim(row.slice(index + 1))

        if (typeof(result[key]) === 'undefined') {
          result[key] = value
        } else if (isArray(result[key])) {
          result[key].push(value)
        } else {
          result[key] = [ result[key], value ]
        }
      }
  )

  return result
}

},{"for-each":29,"trim":69}],55:[function(require,module,exports){
(function (process){
// Generated by CoffeeScript 1.12.2
(function() {
  var getNanoSeconds, hrtime, loadTime, moduleLoadTime, nodeLoadTime, upTime;

  if ((typeof performance !== "undefined" && performance !== null) && performance.now) {
    module.exports = function() {
      return performance.now();
    };
  } else if ((typeof process !== "undefined" && process !== null) && process.hrtime) {
    module.exports = function() {
      return (getNanoSeconds() - nodeLoadTime) / 1e6;
    };
    hrtime = process.hrtime;
    getNanoSeconds = function() {
      var hr;
      hr = hrtime();
      return hr[0] * 1e9 + hr[1];
    };
    moduleLoadTime = getNanoSeconds();
    upTime = process.uptime() * 1e9;
    nodeLoadTime = moduleLoadTime - upTime;
  } else if (Date.now) {
    module.exports = function() {
      return Date.now() - loadTime;
    };
    loadTime = Date.now();
  } else {
    module.exports = function() {
      return new Date().getTime() - loadTime;
    };
    loadTime = new Date().getTime();
  }

}).call(this);



}).call(this,require('_process'))
},{"_process":14}],56:[function(require,module,exports){
(function (Buffer){
/**
 * HTML plot-grid renderer
 *
 * @module  plot-grid
 */
'use strict';

var extend = require('xtend/mutable');
var isBrowser = require('is-browser');
var lg = require('mumath/lg');
var Emitter = require('events').EventEmitter;
var inherits = require('inherits');
var closestNumber = require('mumath/closest');
var mod = require('mumath/mod');
var mag = require('mumath/order');
var within = require('mumath/within');
var uid = require('get-uid');
var insertStyles = require('insert-styles');


insertStyles(Buffer("Omhvc3Qgew0KCXBvc2l0aW9uOiByZWxhdGl2ZTsNCn0NCg0KLmdyaWQgew0KCXBvc2l0aW9uOiBhYnNvbHV0ZTsNCgl0b3A6IDA7DQoJbGVmdDogMDsNCglib3R0b206IDA7DQoJcmlnaHQ6IDA7DQoJcG9pbnRlci1ldmVudHM6IG5vbmU7DQoJZm9udC1mYW1pbHk6IHNhbnMtc2VyaWY7DQp9DQouZ3JpZC1saW5lcyB7DQoJcG9zaXRpb246IGFic29sdXRlOw0KCXRvcDogMDsNCglsZWZ0OiAwOw0KCWJvdHRvbTogMDsNCglyaWdodDogMDsNCglvdmVyZmxvdzogaGlkZGVuOw0KCXBvaW50ZXItZXZlbnRzOiBub25lOw0KfQ0KDQouZ3JpZC1saW5lIHsNCglwb2ludGVyLWV2ZW50czogYWxsOw0KCXBvc2l0aW9uOiBhYnNvbHV0ZTsNCgl0b3A6IDA7DQoJbGVmdDogMDsNCgl3aWR0aDogLjVyZW07DQoJaGVpZ2h0OiAuNXJlbTsNCglvcGFjaXR5OiAuMjU7DQp9DQouZ3JpZC1saW5lW2hpZGRlbl0gew0KCWRpc3BsYXk6IG5vbmU7DQp9DQouZ3JpZC1saW5lOmhvdmVyIHsNCglvcGFjaXR5OiAuNTsNCn0NCg0KQHN1cHBvcnRzICgtLWNzczogdmFyaWFibGVzKSB7DQoJLmdyaWQgew0KCQktLW9wYWNpdHk6IC4xNTsNCgl9DQoJLmdyaWQtbGluZSB7DQoJCW9wYWNpdHk6IHZhcigtLW9wYWNpdHkpOw0KCX0NCgkuZ3JpZC1saW5lOmhvdmVyIHsNCgkJb3BhY2l0eTogY2FsYyh2YXIoLS1vcGFjaXR5KSAqIDIpOw0KCX0NCn0NCg0KLmdyaWQtbGluZS14IHsNCgloZWlnaHQ6IDEwMCU7DQoJd2lkdGg6IDA7DQoJYm9yZGVyLWxlZnQ6IDFweCBzb2xpZDsNCgltYXJnaW4tbGVmdDogLTFweDsNCn0NCi5ncmlkLWxpbmUteDphZnRlciB7DQoJY29udGVudDogJyc7DQoJcG9zaXRpb246IGFic29sdXRlOw0KCXdpZHRoOiAuNXJlbTsNCgl0b3A6IDA7DQoJYm90dG9tOiAwOw0KCWxlZnQ6IC0uMjVyZW07DQp9DQouZ3JpZC1saW5lLXguZ3JpZC1saW5lLW1pbiB7DQoJbWFyZ2luLWxlZnQ6IDBweDsNCn0NCg0KLmdyaWQtbGluZS15IHsNCgl3aWR0aDogMTAwJTsNCgloZWlnaHQ6IDA7DQoJbWFyZ2luLXRvcDogLTFweDsNCglib3JkZXItdG9wOiAxcHggc29saWQ7DQp9DQouZ3JpZC1saW5lLXk6YWZ0ZXIgew0KCWNvbnRlbnQ6ICcnOw0KCXBvc2l0aW9uOiBhYnNvbHV0ZTsNCgloZWlnaHQ6IC41cmVtOw0KCWxlZnQ6IDA7DQoJcmlnaHQ6IDA7DQoJdG9wOiAtLjI1cmVtOw0KfQ0KLmdyaWQtbGluZS15LmdyaWQtbGluZS1tYXggew0KCW1hcmdpbi10b3A6IDBweDsNCn0NCg0KLyogcmFkaWFsIGxpbmVzICovDQouZ3JpZC1saW5lLXIgew0KCWhlaWdodDogMTAwJTsNCgl3aWR0aDogMTAwJTsNCglsZWZ0OiA1MCU7DQoJdG9wOiA1MCU7DQoJYm9yZGVyLXJhZGl1czogNTB2dzsNCglib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxcHg7DQp9DQouZ3JpZC1saW5lLXIuZ3JpZC1saW5lLW1pbiB7DQp9DQoNCi8qIGFuZ3VsYXIgbGluZXMgKi8NCi5ncmlkLWxpbmUtYSB7DQoJaGVpZ2h0OiAwOw0KCXRvcDogNTAlOw0KCWxlZnQ6IDUwJTsNCgl0cmFuc2Zvcm0tb3JpZ2luOiBsZWZ0IGNlbnRlcjsNCgl3aWR0aDogNTAlOw0KCWJvcmRlci10b3A6IDFweCBzb2xpZDsNCn0NCi5ncmlkLWxpbmUtYTphZnRlciB7DQoJY29udGVudDogJyc7DQoJcG9zaXRpb246IGFic29sdXRlOw0KCWhlaWdodDogLjVyZW07DQoJbGVmdDogMDsNCglyaWdodDogMDsNCgl0b3A6IC0uMjVyZW07DQp9DQouZ3JpZC1saW5lLWE6YmVmb3JlIHsNCgljb250ZW50OiAnJzsNCglwb3NpdGlvbjogYWJzb2x1dGU7DQoJd2lkdGg6IC40cmVtOw0KCXJpZ2h0OiAwOw0KCXRvcDogLTFweDsNCgloZWlnaHQ6IDA7DQoJYm9yZGVyLWJvdHRvbTogMnB4IHNvbGlkOw0KfQ0KDQoNCi5ncmlkLWF4aXMgew0KCXBvc2l0aW9uOiBhYnNvbHV0ZTsNCn0NCi5ncmlkLWF4aXMteCB7DQoJdG9wOiBhdXRvOw0KCWJvdHRvbTogMDsNCglyaWdodDogMDsNCglsZWZ0OiAwOw0KCWJvcmRlci1ib3R0b206IDJweCBzb2xpZDsNCgltYXJnaW4tYm90dG9tOiAtLjVyZW07DQp9DQouZ3JpZC1heGlzLXkgew0KCWJvcmRlci1sZWZ0OiAycHggc29saWQ7DQoJcmlnaHQ6IGF1dG87DQoJdG9wOiAwOw0KCWJvdHRvbTogMDsNCglsZWZ0OiAtMXB4Ow0KCW1hcmdpbi1sZWZ0OiAtLjVyZW07DQp9DQouZ3JpZC1heGlzLWEgew0KCWhlaWdodDogMTAwJTsNCgl3aWR0aDogMTAwJTsNCglsZWZ0OiA1MCU7DQoJdG9wOiA1MCU7DQoJYm9yZGVyLXJhZGl1czogNTB2dzsNCglib3gtc2hhZG93OiAwIDAgMCAycHg7DQp9DQouZ3JpZC1heGlzLXIgew0KCWJvcmRlci1sZWZ0OiAycHggc29saWQ7DQoJcmlnaHQ6IGF1dG87DQoJdG9wOiA1MCU7DQoJaGVpZ2h0OiAxMDAlOw0KCWxlZnQ6IC0xcHg7DQoJbWFyZ2luLWxlZnQ6IC0uNXJlbTsNCn0NCg0KLmdyaWQtbGFiZWwgew0KCXBvc2l0aW9uOiBhYnNvbHV0ZTsNCgl0b3A6IGF1dG87DQoJbGVmdDogYXV0bzsNCgltaW4taGVpZ2h0OiAxcmVtOw0KCW1hcmdpbi10b3A6IC0uNXJlbTsNCglmb250LXNpemU6IC44cmVtOw0KCXBvaW50ZXItZXZlbnRzOiBhbGw7DQoJd2hpdGUtc3BhY2U6IG5vd3JhcDsNCn0NCi5ncmlkLWxhYmVsLXggew0KCWJvdHRvbTogYXV0bzsNCgl0b3A6IDEwMCU7DQoJbWFyZ2luLXRvcDogMS41cmVtOw0KCXdpZHRoOiAycmVtOw0KCW1hcmdpbi1sZWZ0OiAtMXJlbTsNCgl0ZXh0LWFsaWduOiBjZW50ZXI7DQp9DQouZ3JpZC1sYWJlbC14OmJlZm9yZSB7DQoJY29udGVudDogJyc7DQoJcG9zaXRpb246IGFic29sdXRlOw0KCWhlaWdodDogLjVyZW07DQoJd2lkdGg6IDA7DQoJYm9yZGVyLWxlZnQ6IDJweCBzb2xpZDsNCgl0b3A6IC0xcmVtOw0KCW1hcmdpbi1sZWZ0OiAtMXB4Ow0KCW1hcmdpbi10b3A6IC0ycHg7DQoJbGVmdDogMXJlbTsNCn0NCg0KLmdyaWQtbGFiZWwteSB7DQoJcmlnaHQ6IDEwMCU7DQoJbWFyZ2luLXJpZ2h0OiAxLjVyZW07DQoJbWFyZ2luLXRvcDogLS41cmVtOw0KfQ0KLmdyaWQtbGFiZWwteTpiZWZvcmUgew0KCWNvbnRlbnQ6ICcnOw0KCXBvc2l0aW9uOiBhYnNvbHV0ZTsNCgl3aWR0aDogLjVyZW07DQoJaGVpZ2h0OiAwOw0KCWJvcmRlci10b3A6IDJweCBzb2xpZDsNCglyaWdodDogLTFyZW07DQoJdG9wOiAuNHJlbTsNCgltYXJnaW4tcmlnaHQ6IC0xcHg7DQp9DQoNCi5ncmlkLWxhYmVsLXIgew0KCXJpZ2h0OiAxMDAlOw0KCXRvcDogY2FsYyg1MCUgLSAuNXJlbSk7DQoJbWFyZ2luLXJpZ2h0OiAxLjVyZW07DQp9DQouZ3JpZC1sYWJlbC1yOmJlZm9yZSB7DQoJY29udGVudDogJyc7DQoJcG9zaXRpb246IGFic29sdXRlOw0KCXdpZHRoOiAuNXJlbTsNCgloZWlnaHQ6IDA7DQoJYm9yZGVyLXRvcDogMnB4IHNvbGlkOw0KCXJpZ2h0OiAtMXJlbTsNCgl0b3A6IC40cmVtOw0KCW1hcmdpbi1yaWdodDogLTFweDsNCn0NCg0KDQouZ3JpZC1sYWJlbC1hIHsNCglib3R0b206IGF1dG87DQoJd2lkdGg6IDJyZW07DQoJdGV4dC1hbGlnbjogY2VudGVyOw0KfQ==","base64"));


module.exports = Grid;

/**
 * @constructor
 */
function Grid (options) {
	if (!(this instanceof Grid)) return new Grid(options);

	extend(this, options);

	this.id = uid();

	if (!isBrowser) return;

	//obtian container
	this.container = options.container || document.body;
	if (typeof this.container === 'string') this.container = document.querySelector(this.container);
	this.container.classList.add('grid-container');

	this.element = document.createElement('div');
	this.element.classList.add('grid');
	this.container.appendChild(this.element);

	if (this.className) this.element.className += ' ' + this.className;

	//create lines container
	this.linesContainer = document.createElement('div');
	this.element.appendChild(this.linesContainer);
	this.linesContainer.classList.add('grid-lines');

	this.update(options);
}

inherits(Grid, Emitter);


Grid.prototype.container = null;
Grid.prototype.viewport = null;

Grid.prototype.lines = null;
Grid.prototype.axes = null;

Grid.prototype.prefixes = {
	8: 'Y', // yotta
	7: 'Z', // zetta
	6: 'E', // exa
	5: 'P', // peta
	4: 'T', // tera
	3: 'G', // giga
	2: 'M', // mega
	1: 'k', // kilo
	0: '',
	'-1': 'm', // milli
	'-2': 'µ', // micro
	'-3': 'n', // nano
	'-4': 'p', // pico
	'-5': 'f', // femto
	'-6': 'a', // atto
	'-7': 'z', // zepto
	'-8': 'y'  // ycoto
};

Grid.prototype.defaultLines = {
	orientation: 'x',
	logarithmic: false,
	min: 0,
	max: 100,
	//detected from range
	values: undefined,
	//copied from values
	titles: undefined,
	format: true,
	units: ''
};

Grid.prototype.defaultAxis = {
	name: '',
	//detected from range
	values: undefined,
	//copied from values
	labels: undefined,
	//copied from labels
	titles: undefined,
	format: true,
	units: ''
};

Grid.prototype.update = function (options) {
	var this$1 = this;

	options = options || {};

	var that = this;

	var element = this.element;
	var linesContainer = this.linesContainer;
	var id = this.id;

	//set viewport
	if (options.viewport) this.viewport = options.viewport;
	var viewport = this.viewport;

	//hide element to avoid live calc
	element.setAttribute('hidden', true);

	var w = this.container.offsetWidth;
	var h = this.container === document.body ? window.innerHeight : this.container.offsetHeight;

	//calc viewport
	if (viewport instanceof Function) {
		viewport = viewport(w, h);
	}

	if (!viewport) viewport = [0,0,w,h];
	if (viewport[2] < 0 || viewport[3] < 0) throw 'Viewport size is negative, probably because grid container size is 0 or something. Please, check the container size.';

	element.style.left = viewport[0] + (typeof viewport[0] === 'number' ? 'px' : '');
	element.style.top = viewport[1] + (typeof viewport[1] === 'number' ? 'px' : '');
	element.style.width = viewport[2] + (typeof viewport[2] === 'number' ? 'px' : '');
	element.style.height = viewport[3] + (typeof viewport[3] === 'number' ? 'px' : '');


	//ensure lines values are not empty
	this.lines = this.lines || [];
	if (options.lines) {
		this.lines = options.lines.map(function (lines, i) { return lines && extend({}, this$1.defaultLines, this$1.lines[i], lines); });
	}
	this.axes = this.axes || [];
	if (options.axes) {
		this.axes = options.axes.map(function (axis, i) { return axis && extend({}, this$1.defaultAxis, this$1.lines[i], axis); });
	}

	//exceptional case of overflow:hidden
	// if (this.container === document.body) {
	// 	if ((viewport[0] + viewport[2]) >= window.innerWidth || (viewport[1] + viewport[3]) >= window.innerHeight) {
	// 		linesContainer.style.overflow = 'hidden';
	// 	}
	// 	else {
	// 		linesContainer.style.overflow = 'visible';
	// 	}
	// }

	//hide all lines, labels, axes first
	var lines = element.querySelectorAll('.grid-line');
	for (var i = 0; i < lines.length; i++) {
		lines[i].setAttribute('hidden', true);
	}
	var axes = element.querySelectorAll('.grid-axis');
	for (var i = 0; i < axes.length; i++) {
		axes[i].setAttribute('hidden', true);
	}
	var labels = element.querySelectorAll('.grid-label');
	for (var i = 0; i < labels.length; i++) {
		labels[i].setAttribute('hidden', true);
	}

	//set lines
	this.lines.forEach(function (lines, idx) {
		if (!lines) return;

		//temp object keeping state of current lines run
		var stats = {
			linesContainer: linesContainer,
			idx: idx,
			id: id
		};

		if (options.lines) {
			if (options.lines[idx] && options.lines[idx].style) {
				this.lines[idx].style = extend(this.lines[idx].style, options.lines[idx].style);
				delete options.lines[idx].style;
			}
			this.lines[idx] = lines = extend(this.lines[idx], options.lines[idx]);
		}
		stats.lines = lines;
		var linesMin = Math.min(lines.max, lines.min);
		var linesMax = Math.max(lines.min, lines.max);
		stats.min = linesMin;
		stats.max = linesMax;

		//detect steps, if not defined, as one per each 50px
		var values = [];
		var minW = Math.min(viewport[2], viewport[3]);
		var intersteps = (lines.orientation === 'x' ? (typeof viewport[2] === 'number' ? viewport[2] : linesContainer.clientWidth) : lines.orientation === 'y' ? (typeof viewport[3] === 'number' ? viewport[3] : linesContainer.clientHeight) : /a/.test(lines.orientation) ? minW * 2 : minW ) / 50 ;
		if (intersteps < 1) {
			values = [linesMin, linesMax];
		}
		//for non-log scale do even distrib
		else if (!lines.logarithmic) {
			var stepSize = (linesMax - linesMin) / Math.floor(intersteps);
			var order = mag(stepSize);

			var scale = /a/.test(lines.orientation) ? [1.5, 3] : [1, 2, 2.5, 5, 10];

			stepSize = closestNumber(stepSize, scale.map(function (v) { return v * order; }));

			var start = stepSize * Math.round(linesMin / stepSize);

			for (var step = start; step <= linesMax; step += stepSize) {
				if (step < linesMin) continue;
				values.push(step);
			}
		}
		else {
			//each logarithmic divisor
			if (linesMin <= 0 && linesMax >= 0) throw Error('Cannot create logarithmic grid spanning over zero, including zero');

			[1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(function (base) {
				var order = mag(linesMin);
				var start = base * order;
				for (var step = Math.abs(start); step <= Math.abs(linesMax); step *=10) {
					if (step < Math.abs(linesMin)) continue;
					values.push(step);
				}
			});
		}


		values = lines.values instanceof Function ?
			values.map(function (v, i) { return lines.values(v, i, stats); }, this).filter(function (v) { return v != null; }) :
			lines.values || values;

		//to avoid collisions
		values = values.sort(function (a, b) { return a - b; });

		stats.values = values;

		//define titles
		var titles = lines.titles instanceof Function ? values.map(function (v, i) { return lines.titles(v, i, stats); }, this) :
			lines.titles === undefined ? values.map(function (value) {
				var order = mag(value);
				var power = Math.floor(Math.log(order) / Math.log(1000));
				if (lines.format && that.prefixes[power]) {
					if (power > 1) value /= (power*1000);
					return value.toLocaleString() + that.prefixes[power] + lines.units;
				}
				else {
					return value.toLocaleString() + lines.units;
				}
		}) : lines.titles;
		stats.titles = titles;

		//draw lines
		var offsets = values.slice().reverse().map(function (value, i) {
			var line = linesContainer.querySelector(("#grid-line-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id));
			var ratio;
			if (!line) {
				line = document.createElement('span');
				line.id = "grid-line-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id;
				line.classList.add('grid-line');
				line.classList.add(("grid-line-" + (lines.orientation)));
				if (value === linesMin) line.classList.add('grid-line-min');
				if (value === linesMax) line.classList.add('grid-line-max');
				line.setAttribute('data-value', value);

				linesContainer.appendChild(line);
			}

			titles && line.setAttribute('title', titles[values.length - 1 - i]);

			if (!lines.logarithmic) {
				ratio = (value - linesMin) / (linesMax - linesMin);
			}
			else {
				ratio = (lg(value) - lg(linesMin)) / (lg(linesMax) - lg(linesMin));
			}
			if (lines.min > lines.max) ratio = 1 - ratio;

			ratio *= 100;
			if (lines.orientation === 'x') {
				line.style.left = ratio + '%';
			}
			else if (lines.orientation === 'y' ) {
				line.style.top = (100 - ratio) + '%';
			}
			else if (/r/.test(lines.orientation)) {
				line.style.marginLeft = -minW*ratio*.005 + 'px';
				line.style.marginTop = -minW*ratio*.005 + 'px';
				line.style.width = minW*ratio*.01 + 'px';
				line.style.height = minW*ratio*.01 + 'px';
				line.style.borderRadius = minW + 'px';
			}
			else if (/a/.test(lines.orientation)) {
				if (ratio && !mod(ratio/100 * 360, 360)) {
					linesContainer.removeChild(line);
				}
				line.style.width = minW / 2 + 'px';
				line.style.transform = "rotate(" + (-ratio * 360 / 100) + "deg)";
			}

			if (lines.style) {
				for (var prop in lines.style) {
					var val = lines.style[prop];
					if (typeof val === 'number') val += 'px';
					line.style[prop] = val;
				}
			}
			line.removeAttribute('hidden');

			return ratio;
		}).reverse();
		stats.offsets = offsets;

		//draw axes
		var axis = this.axes[idx];

		//get axis element
		var axisEl = element.querySelector(("#grid-axis-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + idx + "-" + id));

		//do not paint inexisting axis
		if (!axis) {
			axisEl && axisEl.setAttribute('hidden', true);
			return this;
		}
		else {
			axisEl && axisEl.removeAttribute('hidden');
		}

		if (options.axes) axis = extend(this.axes[idx], options.axes[idx]);
		stats.axis = axis;

		//define values
		var axisValues = axis.values || values;
		stats.axisValues = axisValues;

		//define titles
		var axisTitles = axis.titles instanceof Function ? axisValues.map(function (v, i) { return axis.titles(v, i, stats); }, this) : axis.titles ? axis.titles : axisValues === values ? titles : axis.titles === undefined ? axisValues.slice().map(function (value) {
			return value.toLocaleString();
		}) : axis.titles;
		stats.axisTitles = axisTitles;

		//define labels
		var labels = axis.labels instanceof Function ? axisValues.map(function (v, i) { return axis.labels(v, i, stats); }, this) : axis.labels || axisTitles;
		stats.labels = labels;

		if (!axisEl) {
			axisEl = document.createElement('span');
			axisEl.id = "grid-axis-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + idx + "-" + id;
			axisEl.classList.add('grid-axis');
			axisEl.classList.add(("grid-axis-" + (lines.orientation)));
			axisEl.setAttribute('data-name', axis.name);
			axisEl.setAttribute('title', axis.name);
			element.appendChild(axisEl);

		}
		if (/a/.test(lines.orientation)) {
			axisEl.style.marginLeft = -minW*100*.005 + 'px';
			axisEl.style.marginTop = -minW*100*.005 + 'px';
			axisEl.style.width = minW*100*.01 + 'px';
			axisEl.style.height = minW*100*.01 + 'px';
			axisEl.style.borderRadius = minW + 'px';
		}
		else if (/r/.test(lines.orientation)) {
			axisEl.style.marginTop = -minW*100*.005 + 'px';
			axisEl.style.height = minW*100*.01 + 'px';
		}

		axisEl.removeAttribute('hidden');

		//draw labels
		axisValues.forEach(function (value, i) {
			if (value == null || labels[i] == null) return;

			if (lines.orientation === 'x' || lines.orientation === 'y') {
				var label = element.querySelector(("#grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id));

				if (!label) {
					label = document.createElement('label');
					label.id = "grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id;
					label.classList.add('grid-label');
					label.classList.add(("grid-label-" + (lines.orientation)));
					label.setAttribute('for', ("grid-line-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id));
					element.appendChild(label);
				}

				label.innerHTML = labels[i];

				axisTitles && label.setAttribute('title', axisTitles[i]);

				label.setAttribute('data-value', value);

				//hide label for special log case to avoid overlapping
				if (lines.logarithmic) {
					hideLogLabel(label, value, intersteps);
				}

				if (lines.orientation === 'x') {
					label.style.left = offsets[i] + '%';
				}
				else if (lines.orientation === 'y') {
					label.style.top = (100 - offsets[i]) + '%';
				}

				if (within(value, linesMin, linesMax)) {
					label.removeAttribute('hidden');
				} else {
					label.setAttribute('hidden', true);
				}
			}
			else if (/r/.test(lines.orientation)) {
				var labelTop = element.querySelector(("#grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id + "-top"));
				var labelBottom = element.querySelector(("#grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id + "-bottom"));

				if (!labelTop) {
					labelTop = document.createElement('label');
					labelTop.id = "grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id + "-top";
					labelTop.classList.add('grid-label');
					labelTop.classList.add(("grid-label-" + (lines.orientation)));
					labelTop.setAttribute('for', ("grid-line-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id));
					element.appendChild(labelTop);
				}

				labelTop.innerHTML = labels[i];

				axisTitles && labelTop.setAttribute('title', axisTitles[i]);

				labelTop.setAttribute('data-value', value);

				if(!labelBottom) {
					labelBottom = labelTop.cloneNode();
					labelBottom.id = "grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id + "-bottom";
					if (offsets[i]) {
						element.appendChild(labelBottom);
					}
				}

				labelBottom.innerHTML = labels[i];

				// labelTop.style.marginTop = -(minW*.5*offsets[i]/100) + 'px';
				// labelBottom.style.marginTop = (minW*.5*offsets[i]/100) + 'px';
				labelTop.style.top = viewport[3]/2 - (minW*.5*offsets[i]/100) + 'px';
				labelBottom.style.top = viewport[3]/2 + (minW*.5*offsets[i]/100) + 'px';

				if (within(value, linesMin, linesMax)) {
					labelTop.removeAttribute('hidden');
					labelBottom.removeAttribute('hidden');
				} else {
					labelTop.setAttribute('hidden', true);
					labelBottom.setAttribute('hidden', true);
				}

				//hide label for special log case to avoid overlapping
				if (lines.logarithmic) {
					hideLogLabel(labelTop, value, intersteps * 1.7);
					hideLogLabel(labelBottom, value, intersteps * 1.7);
				}
			}
			else if (/a/.test(lines.orientation)) {
				var label$1 = element.querySelector(("#grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id + "-top"));

				if (!label$1) {
					label$1 = document.createElement('label');
					label$1.id = "grid-label-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id + "-top";
					label$1.classList.add('grid-label');
					label$1.classList.add(("grid-label-" + (lines.orientation)));
					label$1.setAttribute('for', ("grid-line-" + (lines.orientation) + (lines.logarithmic?'-log':'') + "-" + (formatValue(value)) + "-" + idx + "-" + id));
					element.appendChild(label$1);
				}

				label$1.innerHTML = labels[i];

				axisTitles && label$1.setAttribute('title', axisTitles[i]);

				label$1.setAttribute('data-value', value);

				var angle = offsets[i] * Math.PI / 50;
				var angleDeg = offsets[i] * 3.6;
				// label.style.transform = `rotate(${angle}deg)`;
				label$1.style.left = viewport[2]/2 + Math.cos(angle) * minW/2 + 'px';
				label$1.style.top = viewport[3]/2 -Math.sin(angle) * minW/2 + 'px';
				label$1.style.marginTop = (-Math.sin(angle) * .8 - .4) + 'rem';
				label$1.style.marginLeft = -1 + (Math.cos(angle)) + 'rem';

				if (within(value, linesMin, linesMax) && angleDeg < 360 ) {
					label$1.removeAttribute('hidden');
				} else {
					label$1.setAttribute('hidden', true);
				}
			}
		});


		//bloody helpers

		function hideLogLabel (label, value, intersteps) {
			var start = parseInt(value.toExponential()[0]);

			if (values.length > intersteps * 2.8) {
				if (start == 2) label.innerHTML = '';
			}
			if (values.length > intersteps * 2.6) {
				if (start == 5) label.innerHTML = '';
			}
			if (values.length > intersteps * 2.3) {
				if (start == 3) label.innerHTML = '';
			}
			if (values.length > intersteps * 2) {
				if (start == 7) label.innerHTML = '';
			}
			if (values.length > intersteps * 1.7) {
				if (start == 4) label.innerHTML = '';
			}
			if (values.length > intersteps * 1.5) {
				if (start == 6) label.innerHTML = '';
			}
			if (values.length > intersteps * 1.2) {
				if (start == 8) label.innerHTML = '';
			}
			if (values.length > intersteps * .9) {
				if (start == 9) label.innerHTML = '';
			}
		}

	}, this);

	element.removeAttribute('hidden');

	this.emit('update');

	return this;
};

function formatValue (v) {
	return v.toExponential().replace('.', '-').replace('+', '-');
}
}).call(this,require("buffer").Buffer)
},{"buffer":15,"events":27,"get-uid":33,"inherits":37,"insert-styles":39,"is-browser":40,"mumath/closest":57,"mumath/lg":49,"mumath/mod":58,"mumath/order":59,"mumath/within":60,"xtend/mutable":82}],57:[function(require,module,exports){
/**
 * @module  mumath/closest
 */
'use strict';

module.exports = function closest (num, arr) {
	var curr = arr[0];
	var diff = Math.abs (num - curr);
	for (var val = 0; val < arr.length; val++) {
		var newdiff = Math.abs (num - arr[val]);
		if (newdiff < diff) {
			diff = newdiff;
			curr = arr[val];
		}
	}
	return curr;
}
},{}],58:[function(require,module,exports){
/**
 * Looping function for any framesize.
 * Like fmod.
 *
 * @module  mumath/loop
 *
 */

'use strict';
module.exports = function (value, left, right) {
	//detect single-arg case, like mod-loop or fmod
	if (right === undefined) {
		right = left;
		left = 0;
	}

	//swap frame order
	if (left > right) {
		var tmp = right;
		right = left;
		left = tmp;
	}

	var frame = right - left;

	value = ((value + left) % frame) - left;
	if (value < left) value += frame;
	if (value > right) value -= frame;

	return value;
};
},{}],59:[function(require,module,exports){
/**
 * @module mumath/order
 */
'use strict';
module.exports = function (n) {
	n = Math.abs(n);
	var order = Math.floor(Math.log(n) / Math.LN10 + 0.000000001);
	return Math.pow(10,order);
};
},{}],60:[function(require,module,exports){
/**
 * Whether element is between left & right including
 *
 * @param {number} a
 * @param {number} left
 * @param {number} right
 *
 * @return {Boolean}
 */
'use strict';
module.exports = function(a, left, right){
	if (left > right) {
		var tmp = left;
		left = right;
		right = tmp;
	}
	if (a <= right && a >= left) return true;
	return false;
};
},{}],61:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],62:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],63:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":61,"./encode":62}],64:[function(require,module,exports){
var inherits = require('inherits')
var EventEmitter = require('events').EventEmitter
var now = require('right-now')
var raf = require('raf')

module.exports = Engine
function Engine(fn) {
    if (!(this instanceof Engine)) 
        return new Engine(fn)
    this.running = false
    this.last = now()
    this._frame = 0
    this._tick = this.tick.bind(this)

    if (fn)
        this.on('tick', fn)
}

inherits(Engine, EventEmitter)

Engine.prototype.start = function() {
    if (this.running) 
        return
    this.running = true
    this.last = now()
    this._frame = raf(this._tick)
    return this
}

Engine.prototype.stop = function() {
    this.running = false
    if (this._frame !== 0)
        raf.cancel(this._frame)
    this._frame = 0
    return this
}

Engine.prototype.tick = function() {
    this._frame = raf(this._tick)
    var time = now()
    var dt = time - this.last
    this.emit('tick', dt)
    this.last = time
}

},{"events":27,"inherits":37,"raf":65,"right-now":66}],65:[function(require,module,exports){
(function (global){
var now = require('performance-now')
  , root = typeof window === 'undefined' ? global : window
  , vendors = ['moz', 'webkit']
  , suffix = 'AnimationFrame'
  , raf = root['request' + suffix]
  , caf = root['cancel' + suffix] || root['cancelRequest' + suffix]

for(var i = 0; !raf && i < vendors.length; i++) {
  raf = root[vendors[i] + 'Request' + suffix]
  caf = root[vendors[i] + 'Cancel' + suffix]
      || root[vendors[i] + 'CancelRequest' + suffix]
}

// Some versions of FF have rAF but not cAF
if(!raf || !caf) {
  var last = 0
    , id = 0
    , queue = []
    , frameDuration = 1000 / 60

  raf = function(callback) {
    if(queue.length === 0) {
      var _now = now()
        , next = Math.max(0, frameDuration - (_now - last))
      last = next + _now
      setTimeout(function() {
        var cp = queue.slice(0)
        // Clear queue here to prevent
        // callbacks from appending listeners
        // to the current frame's queue
        queue.length = 0
        for(var i = 0; i < cp.length; i++) {
          if(!cp[i].cancelled) {
            try{
              cp[i].callback(last)
            } catch(e) {
              setTimeout(function() { throw e }, 0)
            }
          }
        }
      }, Math.round(next))
    }
    queue.push({
      handle: ++id,
      callback: callback,
      cancelled: false
    })
    return id
  }

  caf = function(handle) {
    for(var i = 0; i < queue.length; i++) {
      if(queue[i].handle === handle) {
        queue[i].cancelled = true
      }
    }
  }
}

module.exports = function(fn) {
  // Wrap in a new function to prevent
  // `cancel` potentially being assigned
  // to the native rAF function
  return raf.call(root, fn)
}
module.exports.cancel = function() {
  caf.apply(root, arguments)
}
module.exports.polyfill = function(object) {
  if (!object) {
    object = root;
  }
  object.requestAnimationFrame = raf
  object.cancelAnimationFrame = caf
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"performance-now":55}],66:[function(require,module,exports){
(function (global){
module.exports =
  global.performance &&
  global.performance.now ? function now() {
    return performance.now()
  } : Date.now || function now() {
    return +new Date
  }

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],67:[function(require,module,exports){
var isDom = require('is-dom')
var lookup = require('browser-media-mime-type')

module.exports.video = simpleMediaElement.bind(null, 'video')
module.exports.audio = simpleMediaElement.bind(null, 'audio')

function simpleMediaElement (elementName, sources, opt) {
  opt = opt || {}

  if (!Array.isArray(sources)) {
    sources = [ sources ]
  }

  var media = opt.element || document.createElement(elementName)

  if (opt.loop) media.setAttribute('loop', 'loop')
  if (opt.muted) media.setAttribute('muted', 'muted')
  if (opt.autoplay) media.setAttribute('autoplay', 'autoplay')
  if (opt.controls) media.setAttribute('controls', 'controls')
  if (opt.crossOrigin) media.setAttribute('crossorigin', opt.crossOrigin)
  if (opt.preload) media.setAttribute('preload', opt.preload)
  if (opt.poster) media.setAttribute('poster', opt.poster)
  if (typeof opt.volume !== 'undefined') media.setAttribute('volume', opt.volume)

  sources = sources.filter(Boolean)
  sources.forEach(function (source) {
    media.appendChild(createSourceElement(source))
  })

  return media
}

function createSourceElement (data) {
  if (isDom(data)) return data
  if (typeof data === 'string') {
    data = { src: data }
    if (data.src) {
      var ext = extension(data.src)
      if (ext) data.type = lookup(ext)
    }
  }

  var source = document.createElement('source')
  if (data.src) source.setAttribute('src', data.src)
  if (data.type) source.setAttribute('type', data.type)
  return source
}

function extension (data) {
  var extIdx = data.lastIndexOf('.')
  if (extIdx <= 0 || extIdx === data.length - 1) {
    return null
  }
  return data.substring(extIdx + 1)
}

},{"browser-media-mime-type":12,"is-dom":41}],68:[function(require,module,exports){
/**
 * @module audio-demo
 */
var Emitter = require('events').EventEmitter;
var inherits = require('inherits');
var extend = require('xtend/mutable');
var sf = 0;
var className = ((require('insert-css')("._66a050cc {\r\n\tmin-height: 100vh;\r\n\tmargin: 0;\r\n\tfont-family: sans-serif;\r\n\tbox-sizing: border-box;\r\n}\r\n\r\n._66a050cc * {\r\n\tbox-sizing: border-box;\r\n}\r\n\r\n._66a050cc a {\r\n\tcolor: inherit;\r\n}\r\n\r\n._66a050cc [hidden] {\r\n\tdisplay: none!important;\r\n}\r\n\r\n._66a050cc:after {\r\n\tcontent: '';\r\n}\r\n._66a050cc.dragover:after {\r\n\tcontent: '⎗';\r\n\tposition: fixed;\r\n\ttop: 0;\r\n\tbottom: 0;\r\n\tleft: 0;\r\n\tright: 0;\r\n\tmargin: auto;\r\n\twidth: 20vh;\r\n\theight: 20vh;\r\n\tz-index: 2;\r\n\tfont-size: 20vh;\r\n\ttext-align: center;\r\n\tline-height: 20vh;\r\n\tdisplay: block;\r\n}\r\n\r\n._66a050cc.dragover:before {\r\n\tcontent: '';\r\n\tposition: fixed;\r\n\ttop: 0;\r\n\tleft: 0;\r\n\tright: 0;\r\n\tbottom: 0;\r\n\tmargin: 0;\r\n\tborder: .2rem dashed;\r\n\tz-index: 1;\r\n\tdisplay: block;\r\n}\r\n\r\n._66a050cc.dragover .source {\r\n}\r\n\r\n._66a050cc.dragover .audio-stop,._66a050cc.dragover .audio-playback {\r\n\tdisplay: none;\r\n}\r\n\r\n._66a050cc .source, ._66a050cc .info, ._66a050cc .status {\r\n\tmargin: 0;\r\n\tpadding: 0;\r\n\tposition: fixed;\r\n\ttop: .75rem;\r\n\tleft: .75rem;\r\n\tdisplay: block;\r\n\tline-height: 1.5rem;\r\n\tfont-size: .9rem;\r\n\tmax-width: 100%;\r\n\tborder: none;\r\n\tbox-shadow: none;\r\n\toutline: none;\r\n\tfill: currentColor;\r\n\tz-index: 999;\r\n}\r\n._66a050cc .source-input {\r\n\tmargin: 0;\r\n\tpadding: 0;\r\n\tborder: 0;\r\n\tdisplay: inline;\r\n\tvertical-align: baseline;\r\n\tline-height: 1rem;\r\n\theight: 1rem;\r\n\tfont-size: .9rem;\r\n\tmax-width: 100%;\r\n\twidth: 82%;\r\n\tborder: none;\r\n\tbox-shadow: none;\r\n\tfont-weight: bolder;\r\n\toutline: none;\r\n\tbackground: none;\r\n\t-webkit-appearance: none;\r\n\tappearance: none;\r\n\tborder-radius: 0;\r\n\tbox-shadow: 0 2px;\r\n\tcolor: inherit;\r\n}\r\n._66a050cc .source-input:focus{\r\n\toutline: none;\r\n}\r\n._66a050cc .source-input-file {\r\n\tposition: fixed;\r\n\ttop: 0;\r\n\tleft: 0;\r\n\tbottom: 0;\r\n\tright: 0;\r\n\topacity: 0;\r\n\tborder: none;\r\n\tcursor: pointer;\r\n}\r\n._66a050cc .source-input-url {\r\n\tfont-family: sans-serif;\r\n\tfont-weight: bold;\r\n\tmin-width: 40vw;\r\n}\r\n._66a050cc .source-input-url:focus {\r\n}\r\n._66a050cc input[type=file],\r\n._66a050cc input[type=file]::-webkit-file-upload-button {\r\n\tcursor: pointer;\r\n}\r\n._66a050cc i {\r\n\tfill: currentColor;\r\n\twidth: 1.5rem;\r\n\theight: 1.5rem;\r\n\tposition: relative;\r\n\tdisplay: inline-block;\r\n\tfont-style: normal;\r\n\tvertical-align: top;\r\n}\r\n._66a050cc .source i, ._66a050cc .info i {\r\n}\r\n._66a050cc .source i svg, ._66a050cc .info i svg {\r\n\tmargin-bottom: -.52rem;\r\n}\r\n._66a050cc i svg {\r\n\tmax-width: 100%;\r\n\tmax-height: 100%;\r\n}\r\n._66a050cc .source-link {\r\n\tposition: relative;\r\n\tfont-weight: bold;\r\n\ttext-decoration: none;\r\n\tbox-shadow: 0px 2px;\r\n\twhite-space: nowrap;\r\n\tcursor: pointer;\r\n}\r\n\r\n._66a050cc .text-length-limiter {\r\n\tdisplay: inline-block;\r\n\tmax-width: 40vw;\r\n\tvertical-align: top;\r\n\twhite-space: nowrap;\r\n\ttext-overflow: ellipsis;\r\n\toverflow: hidden;\r\n}\r\n._66a050cc .source-title, ._66a050cc .info-title {\r\n\tdisplay: inline;\r\n\tword-break: break-all;\r\n}\r\n\r\n._66a050cc .status {\r\n\tleft: auto;\r\n\tright: .75rem;\r\n}\r\n\r\n._66a050cc .fps {\r\n\tdisplay: inline-block;\r\n}\r\n\r\n._66a050cc .fps-canvas {\r\n\theight: 1rem;\r\n\twidth: 2rem;\r\n\tdisplay: inline-block;\r\n\tmargin-right: .15rem;\r\n\tmargin-bottom: -.15rem;\r\n}\r\n\r\n._66a050cc .fps-text {\r\n}\r\n\r\n._66a050cc .fps-value {\r\n}\r\n\r\n._66a050cc .params-button {\r\n    position: relative;\r\n    display: inline-block;\r\n    margin-left: .5rem;\r\n}\r\n._66a050cc .github-link {\r\n\tz-index: 998;\r\n    position: fixed;\r\n    bottom: .75rem;\r\n    right: .75rem;\r\n    width: 1.5rem;\r\n    height: 1.5rem;\r\n    line-height: 1.5rem;\r\n}\r\n\r\n._66a050cc .audio-playback, ._66a050cc .audio-stop {\r\n\tdisplay: inline-block;\r\n}\r\n\r\n._66a050cc .progress {\r\n\tposition: fixed;\r\n\ttop: 0;\r\n\tleft: 0;\r\n\theight: .2rem;\r\n\tbackground: currentColor;\r\n\ttransition: .1s linear width;\r\n\tz-index: 999;\r\n}\r\n\r\n@media (max-width: 42rem) {\r\n\t._66a050cc .text-length-limiter {\r\n\t\tmax-width: 30%;\r\n\t}\r\n\t._66a050cc .source, ._66a050cc .info {\r\n\t\tright: .75rem;\r\n\t\ttext-align: center;\r\n\t}\r\n\t._66a050cc .status {\r\n\t\ttop: auto;\r\n\t\tbottom: .75rem;\r\n\t\tright: .75rem;\r\n\t\tleft: .75rem;\r\n\t\ttext-align: center;\r\n\t}\r\n}\r\n\r\n\r\n._66a050cc .params {\r\n\tbackground: linear-gradient(to bottom, rgba(255,255,255,.85), white);\r\n\tposition: fixed;\r\n\tbottom: 0;\r\n\tright: 0;\r\n\tleft: 0;\r\n\tmargin: auto;\r\n\tpadding: .5rem 0 .5rem .75rem;\r\n\tline-height: 1.5;\r\n\tmax-height: 100vh;\r\n\tmax-width: 100%;\r\n\tz-index: 999;\r\n\toverflow: auto;\r\n}\r\n._66a050cc .params-close {\r\n\tposition: absolute;\r\n\ttop: 0;\r\n\tright: 0;\r\n\theight: 2rem;\r\n\twidth: 2rem;\r\n\ttext-align: center;\r\n\tline-height: 2rem;\r\n\tfont-size: 1rem;\r\n}\r\n\r\n._66a050cc .param {\r\n\theight: 2rem;\r\n\twidth: 15rem;\r\n\tmargin-right: 2.25rem;\r\n\tfloat: left;\r\n}\r\n\r\n@media (max-width: 42rem) {\r\n\t._66a050cc .params {\r\n\t\t/*bottom: 2.5rem;*/\r\n\t\tpadding-right: 2.25rem;\r\n\t}\r\n\t._66a050cc .param {\r\n\t\tmargin-right: 0;\r\n\t\twidth: 100%;\r\n\t\tfloat: none;\r\n\t}\r\n}\r\n\r\n._66a050cc .param-label {\r\n\tfont-size: .75rem;\r\n\tdisplay: inline-block;\r\n\twidth: 33.3%;\r\n\tline-height: 2rem;\r\n\theight: 2rem;\r\n\tvertical-align: top;\r\n\ttext-align: right;\r\n\tpadding-right: 1rem;\r\n}\r\n._66a050cc .param-input {\r\n\twidth: 66.6%;\r\n\theight: 2rem;\r\n\tcolor: inherit;\r\n\tborder: 0;\r\n\tpadding: 0 0;\r\n\tmargin: 0;\r\n\tfont-size: 1rem;\r\n\tbackground: none;\r\n\t/*border-radius: 0;*/\r\n\t/*appearance: none;*/\r\n\t/*-webkit-appearance: none;*/\r\n}\r\n._66a050cc .param-range::-webkit-slider-thumb,\r\n._66a050cc .param-range::-moz-range-thumb {\r\n\twidth: 2rem;\r\n\theight: 2rem;\r\n}\r\n._66a050cc .param-checkbox {\r\n\twidth: 1.5rem;\r\n\theight: 1.5rem;\r\n\tmargin-top: .25rem;\r\n}\r\n@media (max-width: 42rem) {\r\n\t._66a050cc .param-checkbox {\r\n\t\tborder: 1px solid;\r\n\t}\r\n}\r\n\r\n._66a050cc .param-select {\r\n}\r\n\r\n._66a050cc .param-range {\r\n}") || true) && "_66a050cc");

var raf = require('raf');
var now = require('right-now');
var colorParse = require('color-parse');
var hsl = require('color-space/hsl');
var pad = require('left-pad');
var isMobile = require('is-mobile')();
var xhr = require('xhr');
var isUrl = require('is-url');
var ctx = require('audio-context');
var isPlainObject = require('mutype/is-object');
var createPlayer = require('web-audio-player');
var qs = require('querystring');
require('get-float-time-domain-data');


module.exports = StartApp;

/**
 * @constructor
 */
function StartApp (opts, cb) {
	if (!(this instanceof StartApp)) return new StartApp(opts, cb);
	this.init(opts, cb);
}

inherits(StartApp, Emitter);

//Observe paste event
StartApp.prototype.paste = true;

//Allow dropping files to browser
StartApp.prototype.dragAndDrop = true;

//show playpayse buttons
StartApp.prototype.playPause = true;

//show stop button
StartApp.prototype.stop = true;

//show title of track/status messages
StartApp.prototype.title = true;

//show icon
StartApp.prototype.icon = true;

//Enable file select
StartApp.prototype.file = true;

//Enable url select
StartApp.prototype.url = true;

//Default audio context
StartApp.prototype.context = ctx;

//Enable mic input
StartApp.prototype.mic = !!(navigator.mediaDevices || navigator.getUserMedia || navigator.mozGetUserMedia || navigator.webkitGetUserMedia);

//Default (my) soundcloud API token
StartApp.prototype.token = {
	soundcloud: '6b7ae5b9df6a0eb3fcca34cc3bb0ef14',
	youtube: 'AIzaSyBPxsJRzvSSz_LOpejJhOGPyEzlRxU062M'
};

//display micro fps counter
StartApp.prototype.fps = true;

//autostart play
StartApp.prototype.autoplay = !isMobile;
StartApp.prototype.loop = true;


//enable progress indicator
StartApp.prototype.progress = true;

//icon paths
StartApp.prototype.icons = {
	record: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M757.76 818.347h-696.32c-29.013 0-52.907-23.893-52.907-52.907v-532.48c0-29.013 23.893-52.907 52.907-52.907h696.32c29.013 0 52.907 23.893 52.907 52.907v532.48c0 29.013-23.893 52.907-52.907 52.907zM75.093 751.787h669.013v-505.173h-669.013v505.173z\"></path>\n<path d=\"M574.293 636.588c-69.973 0-128-56.32-128-126.293s56.32-126.293 128-126.293c69.973 0 128 56.32 128 126.293s-58.027 126.293-128 126.293zM574.293 450.561c-32.427 0-59.733 27.307-59.733 59.733s27.307 59.733 59.733 59.733 59.733-27.307 59.733-59.733-27.307-59.733-59.733-59.733z\"></path>\n<path d=\"M241.493 636.588c-69.973 0-128-56.32-128-126.293s56.32-126.293 128-126.293c69.973 0 128 56.32 128 126.293s-58.027 126.293-128 126.293zM241.493 450.561c-32.427 0-59.733 27.307-59.733 59.733s27.307 59.733 59.733 59.733c32.427 0 59.733-27.307 59.733-59.733s-27.307-59.733-59.733-59.733z\"></path>\n<path d=\"M572.607 450.113h-332.8c-18.773 0-34.133-14.88-34.133-33.067s15.36-33.067 34.133-33.067h332.8c18.773 0 34.133 14.88 34.133 33.067s-17.067 33.067-34.133 33.067z\"></path>\n</svg>\n",
	error: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M807.303 756.637l-351.17-607.966c-9.601-16.582-27.188-26.702-46.308-26.702-0.074 0-0.143 0-0.208 0s-0.143 0-0.208 0c-19.112 0-36.699 10.12-46.308 26.702l-351.186 607.966c-9.564 16.643-9.564 37.104 0 53.706 9.511 16.61 27.209 26.775 46.525 26.775h702.348c19.308 0 37.014-10.165 46.525-26.775 9.564-16.598 9.564-37.087-0.008-53.706zM89.419 765.556l320.193-554.297 320.193 554.297h-640.382z\"></path>\n<path d=\"M540.178 663.195l-72.859-74.216 70.995-71.763-57.871-57.242-70.161 70.926-70.746-72.058-58.075 57.025 71.584 72.904-73.991 74.804 57.863 57.242 73.157-73.946 72.033 73.353z\"></path>\n</svg>\n",
	soundcloud: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"1206\" height=\"1024\" viewBox=\"0 0 1206 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M54.937 674.845c0 13.601 4.925 23.883 14.799 30.861 9.861 6.973 20.4 9.443 31.63 7.391 10.545-2.033 17.938-5.785 22.187-11.229 4.246-5.445 6.37-14.459 6.37-27.037v-147.916c0-10.545-3.66-19.475-10.963-26.771-7.315-7.315-16.244-10.963-26.771-10.963-10.203 0-18.954 3.66-26.276 10.963s-10.963 16.244-10.963 26.771v147.916zM172.25 738.092c0 9.861 3.479 17.261 10.461 22.187s15.903 7.391 26.771 7.391c11.229 0 20.311-2.463 27.292-7.391 6.973-4.924 10.461-12.331 10.461-22.187v-344.801c0-10.203-3.662-18.956-10.963-26.276-7.315-7.315-16.245-10.963-26.771-10.963-10.203 0-18.956 3.662-26.276 10.963-7.315 7.315-10.963 16.062-10.963 26.276v344.801zM289.060 754.417c0 9.861 3.569 17.261 10.708 22.187 7.139 4.924 16.321 7.391 27.541 7.391 10.887 0 19.813-2.463 26.771-7.391 6.973-4.925 10.462-12.331 10.462-22.187v-314.708c0-10.545-3.662-19.551-10.963-27.037-7.315-7.477-16.062-11.228-26.276-11.228-10.545 0-19.551 3.743-27.037 11.228s-11.229 16.493-11.229 27.037v314.708zM406.369 755.939c0 18.708 12.584 28.062 37.752 28.062s37.751-9.354 37.751-28.062v-510.062c0-28.557-8.676-44.708-26.011-48.461-11.229-2.717-22.277 0.513-33.155 9.692s-16.321 22.097-16.321 38.769v510.062zM525.728 770.737v-554.954c0-17.689 5.263-28.216 15.815-31.63 22.781-5.445 45.391-8.155 67.845-8.155 52.028 0 100.491 12.245 145.37 36.727 44.891 24.491 81.187 57.893 108.893 100.226 27.721 42.34 43.785 89.014 48.203 140.012 20.739-8.835 42.845-13.262 66.306-13.262 47.602 0 88.331 16.831 122.155 50.493 33.839 33.664 50.749 74.125 50.749 121.392 0 47.602-16.923 88.245-50.749 121.907s-74.385 50.493-121.658 50.493l-443.755-0.513c-3.059-1.016-5.356-2.893-6.893-5.605s-2.299-5.11-2.299-7.142z\"></path>\n</svg>\n",
	open: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M799.019 413.071c-13.274-16.986-33.621-26.933-55.195-26.933v-140.089c0-38.664-31.379-70.045-70.045-70.045h-140.089c-38.664 0-70.045 31.379-70.045 70.045h-350.222c-38.664 0-70.045 31.379-70.045 70.045v420.267c0 38.664 31.379 70.045 70.045 70.045h560.355c32.466 0 59.503-22.205 67.453-52.149 0.105-0.315 0.456-0.595 0.525-0.875l70.045-280.178c5.218-20.944 0.49-43.147-12.783-60.133zM113.424 316.095h420.267v-70.045h140.089v140.089h-490.311c-32.15 0-60.168 21.889-67.943 53.059l-2.101 8.336v-131.438zM673.781 736.361h-560.355l70.045-280.178h560.355l-70.045 280.178z\"></path>\n</svg>\n",
	loading: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M640.327 412.161c-45.569 0-82.591 37.025-82.591 85.44s37.025 85.44 82.591 85.44c45.569 0 82.591-37.025 82.591-85.44s-37.025-85.44-82.591-85.44zM409.639 412.161c-45.569 0-82.591 37.025-82.591 85.44s37.025 85.44 82.591 85.44c45.569 0 82.591-37.025 82.591-85.44s-37.025-85.44-82.591-85.44zM178.951 412.161c-45.569 0-82.591 37.025-82.591 85.44s37.025 85.44 82.591 85.44c45.569 0 82.591-37.025 82.591-85.44s-37.025-85.44-82.591-85.44z\"></path>\n</svg>\n",
	url: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M407.776 122.436c-199.872 0-362.496 162.624-362.496 362.496s162.624 362.496 362.496 362.496 362.496-162.624 362.496-362.496-162.624-362.496-362.496-362.496zM407.776 791.652c-39.826 0-83.1-74.988-101.902-187.459 32.351-4.849 66.514-7.709 101.902-7.709s69.551 2.9 101.902 7.709c-18.801 112.471-62.075 187.459-101.902 187.459zM407.776 540.708c-37.837 0-74.271 2.989-108.846 8.152-1.764-20.485-2.674-41.864-2.674-63.896s0.91-43.411 2.674-63.896c34.574 5.164 71.009 8.152 108.846 8.152s74.271-2.989 108.846-8.152c1.764 20.485 2.674 41.864 2.674 63.896s-0.91 43.411-2.674 63.896c-34.574-5.164-71.009-8.152-108.846-8.152zM101.056 484.932c0-42.775 8.797-83.471 24.738-120.445 32.174 19.486 72.596 34.896 117.948 45.9-2.175 23.885-3.262 48.848-3.262 74.586s1.087 50.612 3.262 74.586c-45.409 11.052-85.775 26.374-117.948 45.9-15.91-37.023-24.738-77.751-24.738-120.526zM407.776 178.212c39.826 0 83.1 74.988 101.902 187.459-32.351 4.809-66.474 7.709-101.902 7.709s-69.551-2.9-101.902-7.709c18.801-112.471 62.075-187.459 101.902-187.459zM571.842 410.346c45.409-11.052 85.726-26.374 117.948-45.9 15.853 36.886 24.738 77.614 24.738 120.389s-8.797 83.471-24.738 120.437c-32.222-19.478-72.596-34.977-117.948-45.9 2.175-23.876 3.262-48.848 3.262-74.586s-1.087-50.476-3.262-74.408zM663.102 315.276c-26.188 16.361-59.852 29.813-98.51 39.609-10.69-63.936-29.137-118.222-53.198-158.314 62.349 22.515 115.499 64.387 151.709 118.673zM304.191 196.603c-24.062 40.060-42.509 94.346-53.198 158.314-38.69-9.828-72.322-23.248-98.51-39.609 36.209-54.286 89.359-96.158 151.709-118.673zM152.482 654.661c26.188-16.401 59.852-29.821 98.51-39.649 10.69 63.936 29.137 118.222 53.198 158.322-62.349-22.563-115.499-64.436-151.709-118.673zM511.361 773.334c24.062-40.1 42.509-94.386 53.198-158.322 38.69 9.828 72.322 23.248 98.51 39.649-36.209 54.237-89.359 96.11-151.709 118.673z\"></path>\n</svg>\n",
	mic: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M409.618 681.692c114.138 0 206.667-92.529 206.667-206.667v-165.333c0-114.138-92.529-206.667-206.667-206.667s-206.667 92.529-206.667 206.667v165.333c0 114.138 92.529 206.667 206.667 206.667z\"></path>\n<path d=\"M368.285 844.589v85.104h82.667v-85.104c185.707-20.667 330.667-178.44 330.667-369.563v-82.667h-82.667v82.667c0 159.547-129.83 289.333-289.333 289.333s-289.333-129.787-289.333-289.333v-82.667h-82.667v82.667c0 191.124 144.96 348.94 330.667 369.563z\"></path>\n</svg>\n",
	play: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M213.308 275.971c0-29.549 23.948-53.504 53.497-53.504 9.185 0 14.999 2.398 25.225 6.47l375.259 218.333c17.454 10.348 25.533 26.969 28.647 46.117v5.376c-3.122 19.144-11.203 35.769-28.647 46.117l-375.251 218.325c-10.245 4.080-16.055 6.462-25.225 6.462-29.549 0-53.497-23.955-53.497-53.504v-440.211z\"></path>\n</svg>\n",
	pause: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M147.010 267.438c0-29.495 23.924-53.417 53.432-53.417h112.295c29.495 0 53.432 23.924 53.432 53.417v424.358c0 29.505-23.924 53.425-53.432 53.425h-112.295c-29.495 0-53.432-23.924-53.432-53.425v-424.358z\"></path>\n<path d=\"M452.99 267.438c0-29.495 23.924-53.417 53.399-53.417h112.302c29.495 0 53.409 23.924 53.409 53.417v424.358c0 29.505-23.912 53.425-53.409 53.425h-112.302c-29.49 0-53.409-23.924-53.409-53.425v-424.358z\"></path>\n</svg>\n",
	stop: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M151.962 291.772c0-32.96 26.713-59.665 59.673-59.665h395.855c32.96 0 59.673 26.713 59.673 59.665v395.863c0 32.96-26.713 59.673-59.673 59.673h-395.855c-32.96 0-59.673-26.714-59.673-59.673v-395.863z\"></path>\n</svg>\n",
	eject: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M654.044 263.724l-342.638 220.083c-9.624 6.419-14.116 16.043-14.116 26.306s4.492 19.886 14.116 26.306l343.277 220.722c20.535 13.477 48.12-1.283 48.12-26.306v-440.804c-0.639-25.025-27.594-39.783-48.77-26.306z\"></path>\n<path d=\"M233.766 257.946h-44.915c-34.655 0-62.885 28.233-62.885 62.885v378.568c0 34.655 28.233 62.885 62.885 62.885h44.915c34.655 0 62.885-28.233 62.885-62.885v-378.568c0-34.655-28.233-62.885-62.885-62.885z\"></path>\n</svg>\n",
	settings: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"819\" height=\"1024\" viewBox=\"0 0 819 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M195.945 218.371h452.727c35.966 0 64.683 28.663 64.683 64.104 0 35.449-28.717 63.734-64.683 63.734h-452.727c-35.587 0-64.683-28.285-64.683-63.734s29.082-64.104 64.683-64.104v0z\"></path>\n<path d=\"M197.089 431.455h452.727c35.587 0 64.683 28.286 64.683 63.726 0 35.449-29.088 64.129-64.683 64.129h-452.727c-35.968 0-64.675-28.67-64.675-64.129 0-35.449 28.705-63.726 64.675-63.726v0z\"></path>\n<path d=\"M196.324 644.158h452.727c35.966 0 64.683 28.663 64.683 64.1 0 35.068-28.717 63.754-64.683 63.754h-452.727c-35.968 0-64.675-28.682-64.675-63.754 0-35.439 28.705-64.1 64.675-64.1v0z\"></path>\n</svg>\n",
	github: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated by IcoMoon.io -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"784\" height=\"1024\" viewBox=\"0 0 784 1024\">\n<g id=\"icomoon-ignore\">\n</g>\n<path d=\"M4.168 480.005q0 107.053 52.114 194.314 52.114 90.085 141.399 141.799t194.314 51.714q105.441 0 195.126-51.714 89.685-52.114 141.199-141.599t51.514-194.514q0-106.652-51.714-195.126-52.114-89.685-141.599-141.199t-194.514-51.514q-107.053 0-194.314 52.114-90.085 52.114-141.799 141.399t-51.714 194.314zM68.802 480.005q0-64.634 25.451-124.832t69.482-103.828q44.031-44.031 103.828-69.282t124.432-25.251 124.832 25.251 104.229 69.282q43.631 43.631 68.882 103.828t25.251 124.832q0 69.482-28.487 132.504t-79.989 108.876-117.76 66.458v-113.924q0-42.419-34.747-66.257 85.238-7.672 124.632-43.23t39.383-112.712q0-59.786-36.759-100.593 7.272-21.815 7.272-42.018 0-29.899-13.732-54.939-27.063 0-48.478 8.884t-52.515 30.699q-37.571-8.484-77.565-8.484-45.654 0-85.238 9.295-30.299-22.216-52.314-31.311t-49.891-9.084q-13.332 25.451-13.332 54.939 0 21.004 6.871 42.419-36.759 39.594-36.759 100.192 0 77.165 39.183 112.312t125.644 43.23q-23.027 15.355-31.911 44.843-19.792 6.871-41.207 6.871-16.156 0-27.875-7.272-3.636-2.024-6.66-4.236t-6.26-5.448-5.248-5.048-5.248-6.26-4.236-5.659-4.848-6.46-4.236-5.659q-18.991-25.051-45.243-25.051-14.143 0-14.143 6.060 0 2.424 6.871 8.083 12.931 11.308 13.732 12.12 9.696 7.672 10.908 9.696 11.719 14.544 17.779 31.911 22.627 50.502 77.565 50.502 8.884 0 34.747-4.036v85.649q-66.257-20.603-117.76-66.458t-79.989-108.876-28.487-132.504z\"></path>\n</svg>\n"
};

//do mobile routines like meta, splashscreen etc
StartApp.prototype.mobile = true;

//show params button
StartApp.prototype.params = true;

//show github link
StartApp.prototype.github = 'dfcreative/start-app';

//track history of params
StartApp.prototype.history = false;




//called once
StartApp.prototype.init = function (opts, cb) {
	var this$1 = this;

	var self = this;

	extend(this, opts);


	//add mobile metas
	if (isMobile && this.mobile) {
		var metaEl = document.createElement('meta');
		metaEl.setAttribute('name', 'viewport');
		metaEl.setAttribute('content', 'width=device-width, initial-scale=1, shrink-to-fit=no, user-scalable=no');
		(document.head || document.documentElement).appendChild(metaEl);

		metaEl = document.createElement('meta');
		metaEl.setAttribute('name', 'apple-mobile-web-app-capable');
		metaEl.setAttribute('content', 'yes');
		(document.head || document.documentElement).appendChild(metaEl);

		// setTimeout(() => {
		// 	window.scrollTo(0, 0);
		// }, 0);
	}

	//ensure container
	if (!this.container) this.container = document.body || document.documentElement;
	this.container.classList.add(className);

	//create container
	this.sourceEl = document.createElement('div');
	this.sourceEl.classList.add('source');
	this.container.appendChild(this.sourceEl);

	//create error/info container
	this.infoEl = document.createElement('div');
	this.infoEl.classList.add('info');
	this.infoEl.setAttribute('hidden', true);
	this.infoEl.innerHTML = "<i class=\"info-icon\">" + (this.icons.error) + "</i>\n\t\t<span class=\"info-text\"><strong class=\"info-title\">Error</strong></span>";
	this.infoTitle = this.infoEl.querySelector('.info-title');
	this.infoIcon = this.infoEl.querySelector('.info-icon');
	this.container.appendChild(this.infoEl);

	//create dynamic style
	this.styleEl = document.createElement('style');
	(document.head || document.documentElement).appendChild(this.styleEl);

	if (!this.color) this.color = getComputedStyle(this.container).color;
	this.setColor(this.color);

	//create layout
	this.sourceEl.innerHTML = "\n\t\t<i class=\"source-icon\" hidden>" + (this.icons.record) + "</i>\n\t\t<span class=\"source-text\"></span>\n\t\t<a href=\"#audio\" class=\"audio-playback\" hidden><i class=\"audio-icon\">" + (this.icons.play) + "</i></a>\n\t\t<a href=\"#stop\" class=\"audio-stop\" title=\"Reset\" hidden><i class=\"audio-icon\">" + (this.icons.eject) + "</i></a>\n\t";
	this.sourceIcon = this.sourceEl.querySelector('.source-icon');
	this.sourceContent = this.sourceEl.querySelector('.source-text');
	this.sourceIcon.innerHTML = this.file ? this.icons.open : this.url ? this.icons.url : this.mic ? this.icons.mic : this.icons.open;

	this.sourceContent.innerHTML = "\n\t\t<span class=\"source-links\">\n\t\t\t<a href=\"#open-file\" " + (this.file ? '' : 'hidden') + " class=\"source-link source-link-file\">Open file</a>" + (this.file && this.url && this.mic ? ',' : this.file && (this.url || this.mic) ? ' or' : '') + "\n\t\t\t<a href=\"#enter-url\" " + (this.url ? '' : 'hidden') + " class=\"source-link source-link-url\">enter URL</a>\n\t\t\t" + (this.url && this.mic ? ' or' : '') + "\n\t\t\t<a href=\"#enable-mic\" " + (this.mic ? '' : 'hidden') + " class=\"source-link source-link-mic\">\n\t\t\t\tenable microphone\n\t\t\t</a>\n\t\t</span>\n\t\t<input class=\"source-input source-input-file\" hidden type=\"file\"/>\n\t\t<input placeholder=\"https://soundcloud.com/user/track\" hidden class=\"source-input source-input-url\" type=\"url\" value=\"" + (this.source || '') + "\"/>\n\t\t<strong class=\"source-title\" hidden></strong>\n\t";
	this.sourceTitle = this.sourceEl.querySelector('.source-title');
	this.sourceLinks = this.sourceEl.querySelector('.source-links');
	this.sourceInputFile = this.sourceEl.querySelector('.source-input-file');
	this.sourceEl.querySelector('.source-link-file').addEventListener('click', function (e) {
		e.preventDefault();
		this$1.sourceInputFile.click();
	});
	this.sourceInputFile.addEventListener('change', function (e) {
		if (!this$1.sourceInputFile.files.length) return this$1;
		this$1.setSource(this$1.sourceInputFile.files);
	});
	this.sourceInputURL = this.sourceEl.querySelector('.source-input-url');
	var lastURL;
	this.sourceInputURL.addEventListener('focus', function (e) {
		lastURL = this$1.sourceInputURL.value;
	});
	this.sourceInputURL.addEventListener('blur', function (e) {
		//if nothing changed - blur
		if (lastURL === this$1.sourceInputURL.value) {
			this$1.showInput();
		}
	});
	this.sourceInputURL.addEventListener('keypress', function (e) {
		if (e.which === 13) {
			this$1.sourceInputURL.blur();
			this$1.sourceInputURL.dispatchEvent(new Event('change'));
		}
	});
	this.sourceInputURL.addEventListener('change', function (e) {
		e.preventDefault();
		this$1.setSource(this$1.sourceInputURL.value);
	});
	this.sourceEl.querySelector('.source-link-url').addEventListener('click', function (e) {
		e.preventDefault();
		this$1.hideInput();
		this$1.sourceInputURL.removeAttribute('hidden');
		this$1.sourceInputURL.focus();
		this$1.sourceIcon.innerHTML = this$1.icons.url;
	});
	this.sourceInputMic = this.sourceEl.querySelector('.source-link-mic');
	this.sourceInputMic.addEventListener('click', function (e) {
		e.preventDefault();

		if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
			navigator.mediaDevices.getUserMedia({audio: true, video: false})
			.then(enableMic).catch(errMic);
		}
		else {
			try {
				navigator.getUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);
				navigator.getUserMedia({audio: true, video: false}, enableMic, errMic);
			} catch (e) {
				errMic(e);
			}
		}

		function enableMic(stream) {
			self.showSource('Microphone', self.icons.mic);

			self.audioEl.setAttribute('hidden', true);

			//an alternative way to start media stream - do not work in chrome
			var streamUrl = URL.createObjectURL(stream);
			// self.audio.src = streamUrl;
			// self.play();

			//create media stream source node
			self.micNode = self.context.createMediaStreamSource(stream);
			self.micNode.connect(self.context.destination);

			self.audioStop.querySelector('i').innerHTML = self.icons.stop;
			self.stop && self.audioStop.removeAttribute('hidden');

			self.emit('ready', self.micNode);
			self.emit('source', self.micNode, streamUrl);
			self.emit('play', self.micNode);
		}
		function errMic (err) {
			self.hideInput();
			self.error(err, cb);
		}
	});


	this.audioEl = this.sourceEl.querySelector('.audio-playback');
	this.audioStop = this.sourceEl.querySelector('.audio-stop');
	this.audioIcon = this.sourceEl.querySelector('.audio-icon');


	this.playPause && this.audioEl.addEventListener('click', function (e) {
		e.preventDefault();
		if (!this$1.player) throw Error('Set audio source');

		if (!this$1.player.playing) {
			this$1.play();
		}
		else {
			this$1.pause();
		}
	});
	this.stop && this.audioStop.addEventListener('click', function (e) {
		e.preventDefault();
		this$1.reset();
		this$1.showInput();
	});

	//init progress bar
	var progress = this.progressEl = document.createElement('div');
	this.progressEl.classList.add('progress');
	if (!this.progress) this.progressEl.setAttribute('hidden', true);
	this.progressEl.setAttribute('title', '00:00');
	this.container.appendChild(progress);

	setInterval(function () {
		var currentTime = this$1.player && this$1.player.currentTime || this$1.player && this$1.player.element && this$1.player.element.currentTime || 0;
		if (this$1.player && this$1.player.currentTime) {
			progress.style.width = ((currentTime / this$1.player.duration * 100) || 0) + '%';
			progress.setAttribute('title', ((this$1.getTime(currentTime)) + " / " + (this$1.getTime(this$1.player.duration)) + " played"));
		}
	}, 100);


	//technical element for fps, params, info etc
	this.statusEl = document.createElement('div');
	this.statusEl.classList.add('status');
	this.container.appendChild(this.statusEl);

	//init fps
	this.fpsEl = document.createElement('div');
	this.fpsEl.classList.add('fps');
	this.fpsEl.setAttribute('hidden', true);
	this.fpsEl.innerHTML = "\n\t\t<canvas class=\"fps-canvas\"></canvas>\n\t\t<span class=\"fps-text\">\n\t\t\tfps <span class=\"fps-value\">60.0</span>\n\t\t</span>\n\t";
	this.fpsCanvas = this.fpsEl.querySelector('.fps-canvas');
	var fpsValue = this.fpsValue = this.fpsEl.querySelector('.fps-value');
	this.statusEl.appendChild(this.fpsEl);

	var w = this.fpsCanvas.width = parseInt(getComputedStyle(this.fpsCanvas).width) || 1;
	var h = this.fpsCanvas.height = parseInt(getComputedStyle(this.fpsCanvas).height) || 1;

	var ctx = this.fpsCanvas.getContext('2d');
	var count = 0;
	var last = 0;
	var len = this.fpsCanvas.width;
	var values = Array(len).fill(0);
	var updatePeriod = 1000;
	var maxFPS = 100;
	var that = this;


	//create params template
	this.paramsEl = document.createElement('div');
	this.paramsEl.classList.add('params');
	this.paramsEl.setAttribute('hidden', true);
	this.paramsEl.innerHTML = "<a class=\"params-close\" href=\"#close-params\"><i class=\"icon-close\">✕</i></a>";

	//init params data
	this.paramsList = []; //list of params values
	this.paramsCache = {}; //name: idx

	//extend params with the read history state
	if (this.history) {
		var params = qs.parse(location.hash.slice(1));
	}

	this.addParams(this.params);

	if (this.history) {
		for (var param in params){
			var value = params[param];
			if (value.toLowerCase() === 'false') {
				value = false;
			}
			else if (value.toLowerCase() === 'true') {
				value = true;
			}
			else if (/[-0-9\.]+/.test(value)) {
				value = parseFloat(value);
			}
			this$1.setParamValue(param, value);
		}
	}

	this.container.appendChild(this.paramsEl);

	//params button
	this.paramsBtn = document.createElement('a');
	this.paramsBtn.classList.add('params-button');
	this.paramsBtn.href = '#params';
	this.paramsBtn.innerHTML = "<i>" + (this.icons.settings) + "</i>";
	this.paramsBtn.setAttribute('hidden', true);
	this.statusEl.appendChild(this.paramsBtn);

	this.paramsBtn.addEventListener('click', function (e) {
		e.preventDefault();
		if (this$1.paramsEl.hasAttribute('hidden')) {
			this$1.paramsEl.removeAttribute('hidden');
		}
		else {
			this$1.paramsEl.setAttribute('hidden', true);
		}
	});
	this.paramsEl.querySelector('.params-close').addEventListener('click', function (e) {
		e.preventDefault();
		if (this$1.paramsEl.hasAttribute('hidden')) {
			this$1.paramsEl.removeAttribute('hidden');
		}
		else {
			this$1.paramsEl.setAttribute('hidden', true);
		}
	});


	//add gh link
	if (this.github) {
		this.ghLink = document.createElement('a');
		this.ghLink.classList.add('github-link');
		this.ghLink.href = isUrl(this.github) ? this.github : '//github.com/' + this.github;
		this.ghLink.innerHTML = "<i>" + (this.icons.github) + "</i>";
		this.container.appendChild(this.ghLink);
	}

	//update history
	if (this.history) {
		this._wait = false;
		this.on('change', function () {
			if (this$1._wait) return;

			this$1.updateHistory();

			this$1._wait = true;
			setTimeout(function () {
				this$1._wait = false;
			}, 100);
		});
	}

	//observe onpaste
	if (this.paste) {
		this.container.addEventListener('paste', function (e) {
			e.preventDefault();
			//FIXME: this returns files length 0 if pasted an audio
			var dt = e.clipboardData;
			if (/text/.test(dt.types[0])) {
				var src = dt.getData(dt.types[0]);
				this$1.setSource(src);
			}
			else {
				this$1.setSource(dt.files);
			}
		});
	}

	//enable update routine
	raf(function measure () {
		count++;
		var t = now();
		if (t - last > updatePeriod) {
			var color = that.color;
			var transparentColor = that.transparentColor;
			last = t;
			values.push((count) / (maxFPS * updatePeriod * 0.001));
			values = values.slice(-len);
			count = 0;

			ctx.clearRect(0, 0, w, h);
			ctx.fillStyle = color;
			for (var i = 0; i < len; i++) {
				ctx.fillRect(i, h - h * values[i], 1, h * values[i]);
			}

			fpsValue.innerHTML = (values[values.length - 1]*maxFPS).toFixed(1);
		}

		raf(measure);
	});

	this.update();

	setTimeout(function () {
		if (this$1.source) {
			this$1.setSource(this$1.source, function (err) {
				cb && cb(null, this$1.source);
			});
		}
		else {
			cb && cb(null, this$1.source);
		}
	});
}


/**
 * Init settings
 */
StartApp.prototype.update = function (opts) {
	var this$1 = this;

	extend(this, opts);

	if (this.color) {
		this.setColor(this.color);
	}

	if (this.dragAndDrop && !this.isDnD) {
		this.isDnD = true;
		var title, icon, target, isSource;

		this.container.addEventListener('dragstart', function (e) {
			//ignore dragging the container
			//FIXME: maybe we need a bit more specifics here, by components
			e.preventDefault();
			return false;
		}, false);
		this.container.addEventListener('dragenter', function (e) {
			if (target) return;
			target = e.target;
			// if (e.target != this.container) return;

			this$1.container.classList.add('dragover');
			e.dataTransfer.dropEffect = 'copy';

			var dt = e.dataTransfer;
			var list = dt.files, src;

			this$1.hideInput();
			this$1.info("drop audio file", this$1.icons.record);
		});

		this.container.addEventListener('dragleave', function (e) {
			if (e.target != this$1.container) return;

			target = null;
			this$1.container.classList.remove('dragover');
			if (this$1.source) {
				this$1.showSource();
			}
			else {
				this$1.showInput();
			}
		}, false);

		this.container.addEventListener('drop', function (e) {
			e.preventDefault();
			this$1.container.classList.remove('dragover');
			target = null;

			var dt = e.dataTransfer;
			this$1.setSource(dt.files);
		}, false);

		this.container.addEventListener('dragover', function (e) {
			e.preventDefault();
		}, false);
	}

	if (this.fps) {
		this.fpsEl.removeAttribute('hidden');
	}
	else {
		this.fpsEl.setAttribute('hidden', true);
	}

	if (this.title) {
		this.sourceTitle.removeAttribute('hidden');
	} else {
		this.sourceTitle.setAttribute('hidden', true);
	}

	if (this.icon) {
		this.sourceIcon.removeAttribute('hidden');
	} else {
		this.sourceIcon.setAttribute('hidden', true);
	}

	if (this.params) {
		this.paramsBtn.removeAttribute('hidden');
	} else {
		this.paramsBtn.setAttribute('hidden', true);
	}

	this.updateHistory();

	return this;
};

//update hash state
StartApp.prototype.updateHistory = function () {
	if (!this.history) return;

	var params = {};
	this.paramsList.forEach(function (param) {
		params[param.name] = param.value;
	});

	location.hash = '#' + qs.stringify(params);
}

//inner method for setting color
StartApp.prototype.setColor = function (color) {
	this.color = color = color || this.color;

	var parsed = colorParse(color);

	if (parsed.space === 'hsl') {
		var values = hsl.rgb(parsed.values);
	}
	else {
		var values = parsed.values;
	}
	this.colorValues = values;

	var yiq = (values[0] * 299 + values[1] * 587 + values[2] * 114) / (1000);
	var isDark = yiq < 128;

	var inverseValues = values.map(function (v) { return 255 - v; }).map(function (v) { return v * ( !isDark ? .2 : 1.8); }).map(function (v) { return Math.max(Math.min(v, 255), 0); }).map(function (v) { return !isDark ? v*.2 : 255*.8+v*.2; });
	this.color = "rgba(" + (values.join(', ')) + ", " + (parsed.alpha) + ")";
	this.inverseColor = "rgba(" + (inverseValues.map(function (v) { return v.toFixed(0); }).join(', ')) + ", " + (parsed.alpha) + ")";
	this.transparentColor = "rgba(" + (values.join(', ')) + ", 0.1)";
	this.semiTransparentColor = "rgba(" + (values.join(', ')) + ", 0.25)";

	var semiTransparentInverseColor = "rgba(" + (inverseValues.map(function (v) { return v.toFixed(0); }).join(', ')) + ", .75)";

	this.styleEl.innerHTML = "\n\t\t." + className + " {\n\t\t\tcolor: " + (this.color) + ";\n\t\t}\n\t\t." + className + " .source-input,\n\t\t." + className + " .source-link\n\t\t{\n\t\t\tbox-shadow: 0 2px " + (this.semiTransparentColor) + ";\n\t\t}\n\t\t." + className + " .source-input:focus,\n\t\t." + className + " .source-link:hover\n\t\t{\n\t\t\tbox-shadow: 0 2px " + (this.color) + ";\n\t\t}\n\n\t\t." + className + " .params {\n\t\t\tbackground: linear-gradient(to bottom, rgba(" + (inverseValues.map(function (v) { return v.toFixed(0); }).join(', ')) + ", .5), rgba(" + (inverseValues.map(function (v) { return v.toFixed(0); }).join(', ')) + ", .75));\n\t\t}\n\n\t\t." + className + " .params-button {\n\t\t\tcolor: " + (this.color) + "\n\t\t}\n\n\t\t::selection{\n\t\t\tbackground: " + (this.semiTransparentColor) + ";\n\t\t\tcolor: " + (this.inverseColor) + ";\n\t\t}\n\t\t::-moz-selection{\n\t\t\tbackground: " + (this.semiTransparentColor) + ";\n\t\t\tcolor: " + (this.inverseColor) + ";\n\t\t}\n\n\t\t." + className + " .fps-canvas { background:" + (this.transparentColor) + "; }\n\n\t\t::-moz-placeholder { color:" + (this.semiTransparentColor) + "; }\n\t\tinput:-moz-placeholder { color:" + (this.semiTransparentColor) + "; }\n\t\t:-ms-input-placeholder { color:" + (this.semiTransparentColor) + "; }\n\t\t::-webkit-input-placeholder { color:" + (this.semiTransparentColor) + "; }\n\t";

	return this;
};


/**
 * Set source to play
 */
StartApp.prototype.setSource = function (src, cb) {
	var this$1 = this;

	var self = this;

	//Undefined source - no action
	if (!src) {
		return this;
	}

	//find first audio file from the list
	if (src instanceof FileList) {
		var list = src;
		src = null;

		for (var i = 0; i < list.length; i++) {
			if (/audio/.test(list[i].type)) {
				src = list[i];
				break;
			}
		}

		if (!src) {
			this.error('Not an audio', cb);
			return this;
		}
	}

	//File instance case
	if (src instanceof File) {
		var url = URL.createObjectURL(src);
		this.showSource(("<a class=\"source-link\" href=\"" + url + "\" target=\"_blank\" title=\"" + (src.name) + "\"><span class=\"text-length-limiter\">" + (src.name) + "</span></a>"), this.icons.record);
		this.source = url;

		this.reset();
		this.player = createPlayer(url, {
			context: this.context,
			loop: this.loop,
			buffer: isMobile,
			crossOrigin: 'Anonymous'
		}).on('load', function () {
			this$1.playPause && this$1.audioEl.removeAttribute('hidden');
			this$1.stop && this$1.audioStop.removeAttribute('hidden');

			this$1.emit('source', this$1.player.node, url);
			cb && cb(null, url);
			this$1.autoplay && this$1.play();
		}).on('error', function (e) { return this$1.error(e); });

		return this;
	}


	if (/soundcloud/.test(src)) {
		this.info('connecting to soundcloud');
		var token = this.token.soundcloud || this.token;

		//sad ios workaround
		if (isMobile) {
			xhr({
				uri: ("https://api.soundcloud.com/resolve.json?client_id=" + (this.token.soundcloud || this.token) + "&url=" + src + "&format=json"),
				method: 'GET'
			}, function () {
				xhr({
					uri: ("https://api.soundcloud.com/resolve.json?client_id=" + (this$1.token.soundcloud || this$1.token) + "&url=" + src + "&_status_code_map[302]=200&format=json"),
					method: 'GET'
				}, function (err, response) {
					if (err) return this.error(err, cb);

					var obj = JSON.parse(response.body);
					xhr({
						uri: obj.location,
						method: 'GET'
					}, function (err, response) {
						if (err) return this.error(err, cb);

						var json = JSON.parse(response.body);

						setSoundcloud(json);
					});
				});
			});
		}

		else {
			xhr({
				uri: ("https://api.soundcloud.com/resolve.json?client_id=" + (this.token.soundcloud || this.token) + "&url=" + src),
				method: 'GET'
			}, function (err, response) {
				if (err) {
					return this$1.error(err, cb);
				}

				var json = JSON.parse(response.body);

				setSoundcloud(json);
			});
		}

		function setSoundcloud (json) {
			var streamUrl = json.stream_url + '?client_id=' + token;

			//FIXME: play list of tracks properly
			if (json.tracks) {
				var id = Math.floor(Math.random() * json.tracks.length);
				return self.setSource(json.tracks[id].permalink_url, cb);
			}

			self.source = streamUrl;

			var titleHtml = "<a class=\"source-link\" href=\"" + (json.permalink_url) + "\" target=\"_blank\" title=\"" + (json.title) + "\"><span class=\"text-length-limiter\">" + (json.title) + "</span></a>";
			if (json.user) {
				titleHtml += " by <a class=\"source-link\" href=\"" + (json.user.permalink_url) + "\" target=\"_blank\" title=\"" + (json.user.username) + "\"><span class=\"text-length-limiter\">" + (json.user.username) + "</span></a>\n\t\t\t\t";
			}

			self.reset();
			self.player = createPlayer(streamUrl, {
				context: self.context,
				loop: self.loop,
				buffer: isMobile,
				crossOrigin: 'Anonymous'
			})
			.on('load', function () {
				self.showSource(titleHtml, self.icons.soundcloud);
				self.emit('source', self.player.node, streamUrl);
				cb && cb(null, self.player.node, streamUrl);

				self.playPause && self.audioEl.removeAttribute('hidden');
				self.stop && self.audioStop.removeAttribute('hidden');

				self.autoplay && self.play();
			})
			.on('decoding', function () {
				self.info(("decoding " + titleHtml));
			})
			.on('progress', function (e) {
				if (e === 0) return;
				self.info(("loading " + titleHtml))
			})
			.on('error', function (err) {
				self.error(err, function () {
					cb && cb(err);
				});
			})
		}
	}

	// else if (/youtu/.test(url.hostname)) {

	// 	self.source = url.href;
	// 	self.audio.src = url.href;
	//
	// 	self.audioEl.removeAttribute('hidden');
	// 	self.audioStop.removeAttribute('hidden');
	// }

	//default url
	else {
		// if (!isUrl(src)) {
		// 	this.error();
		// 	return this;
		// }

		this.info(("loading " + src));

		this.reset();
		this.player = createPlayer(src, {
			context: this.context,
			loop: this.loop,
			buffer: isMobile, //FIXME: this can be always false here i guess
			crossOrigin: 'Anonymous'
		}).on('load', function () {
			this$1.source = src;

			this$1.showSource(("\n\t\t\t\t<a class=\"source-link\" href=\"" + src + "\" target=\"_blank\" title=\"Open " + src + "\"><span class=\"text-length-limiter\" style=\"max-width: 40vw\">" + src + "</span></a>\n\t\t\t"), this$1.icons.url);

			this$1.playPause && this$1.audioEl.removeAttribute('hidden');
			this$1.stop && this$1.audioStop.removeAttribute('hidden');

			this$1.emit('source', this$1.player.node, src);
			cb && cb(null, this$1.player.node, src);
			this$1.autoplay && this$1.play();
		}).on('error', function (err) {
			this$1.error(err, function () {
				cb && cb(err);
			});
		});

	}

	return this;
};


/**
 * Display error
 */
StartApp.prototype.error = function (err, cb) {
	var this$1 = this;

	this.infoTitle.innerHTML = err || "bad source";
	this.infoEl.setAttribute('title', this.infoTitle.innerHTML);
	this.infoIcon.innerHTML = this.icons.error;

	this.sourceEl.setAttribute('hidden', true);
	this.infoEl.removeAttribute('hidden');

	var isSource = !!this.source;

	setTimeout(function () {
		this$1.sourceEl.removeAttribute('hidden');
		this$1.infoEl.setAttribute('hidden', true);

		if (!isSource) this$1.showInput();

		cb && cb('Bad url');
	}, 1600);

	return this;
}

//display loading/info status
StartApp.prototype.info = function (msg, icon) {
	this.infoTitle.innerHTML = msg || "loading";
	this.infoIcon.innerHTML = icon || this.icons.loading;
	this.infoEl.setAttribute('title', this.infoTitle.innerHTML);

	this.sourceEl.setAttribute('hidden', true);
	this.infoEl.removeAttribute('hidden');

	var isSource = !!this.source;

	// to && setTimeout(() => {
	// 	this.error('It takes too long to load. Try again later');
	// }, to);

	return this;
};

//show source
StartApp.prototype.showSource = function (title, icon) {
	this.hideInput();
	this.sourceEl.removeAttribute('hidden');
	this.infoEl.setAttribute('hidden', true);

	if (icon) this.sourceIcon.innerHTML = icon;
	if (title) this.sourceTitle.innerHTML = title;
	this.sourceIcon.setAttribute('title', this.sourceTitle.textContent);

	this.audioEl.removeAttribute('hidden');

	return this;
}


/**
 * Show/hide source input default view
 */
StartApp.prototype.showInput = function () {
	this.infoEl.setAttribute('hidden', true);
	this.sourceTitle.innerHTML = '';
	this.sourceLinks.removeAttribute('hidden');
	this.sourceInputURL.setAttribute('hidden', true);
	this.sourceIcon.innerHTML = this.file ? this.icons.open : this.url ? this.icons.url : this.mic ? this.icons.mic : this.icons.open;

	this.audioEl.setAttribute('hidden', true);

	//this guy keeps state
	this.source = null;

	return this;
}

StartApp.prototype.hideInput = function () {
	this.sourceLinks.setAttribute('hidden', true);

	return this;
};


/**
 * Play/stop/reset audio
 */
StartApp.prototype.play = function () {
	this.audioEl.title = "Pause";
	this.audioIcon.innerHTML = this.icons.pause;
	this.playPause && this.stop && this.audioStop.setAttribute('hidden', true);

	if (!this.player) throw Error('Set audio source');
	this.player.play();
	this.emit('play', this.player.node);

	return this;
}
StartApp.prototype.pause = function () {
	this.audioEl.title = "Play";
	this.audioIcon.innerHTML = this.icons.play;
	this.playPause && this.stop && this.audioStop.removeAttribute('hidden');

	if (!this.player) throw Error('Set audio source');
	this.player.pause();
	this.emit('pause', this.player.node);

	return this;
}
StartApp.prototype.reset = function () {
	this.source = '';
	// this.sourceInputURL.value = '';

	if (this.micNode) {
		this.micNode.disconnect();
	}

	this.emit('stop', this.player && this.player.node);
	this.player && this.player.stop();

	this.audioStop.querySelector('i').innerHTML = this.icons.eject;
	this.stop && this.audioStop.setAttribute('hidden', true);

	return this;
}
StartApp.prototype.getTime = function (time) {
	return pad((time / 60)|0, 2, 0) + ':' + pad((time % 60)|0, 2, 0);
}




/** Create param based off options */
StartApp.prototype.addParams = function (list) {
	var this$1 = this;

	if (isPlainObject(list)) {
		var params = [];
		for (var name in list) {
			if (!isPlainObject(list[name])) {
				list[name] = {value: list[name]};
			}
			list[name].name = name;
			params.push(list[name]);
		}
		this.params = true;
	}
	else if (Array.isArray(list)){
		params = list;
		this.params = true;
	}
	else {
		params = [];
	}

	params.forEach(function (opts) { return this$1.addParam(opts); });

	return this;
}

StartApp.prototype.addParam = function (name, opts, cb) {
	if (isPlainObject(name)) {
		cb = opts;
		opts = name;
		name = opts.name;
	}
	if (opts instanceof Function) {
		cb = opts;
		opts = {};
	}

	if (!isPlainObject(opts)) {
		opts = {value: opts}
	}

	if (typeof name === 'string') {
		opts.name = name;
	}

	var type = opts.type || 'text';
	cb = cb || opts.change || opts.cb;

	var el = document.createElement('div');
	el.classList.add('param');

	var title = opts.label || opts.name.slice(0,1).toUpperCase() + opts.name.slice(1);
	var name = opts.name.toLowerCase();
	name = name.replace(/\s/g, '-');
	el.innerHTML = "<label for=\"" + name + "\" class=\"param-label\">" + title + "</label>";

	if (!opts.type) {
		if (opts.values) {
			opts.type = 'select';
		}
		else if (opts.min || opts.max || opts.step || typeof opts.value === 'number') {
			opts.type = 'range';
		}
		else if (typeof opts.value === 'boolean') {
			opts.type = 'checkbox';
		}
	}

	switch (opts.type) {
		case 'select':
			opts = extend({
				values: {},
				name: 'noname-select'
			}, opts);
			var html = "<select\n\t\t\t\tid=\"" + name + "\" class=\"param-input param-select\" title=\"" + (opts.value) + "\">";
			if (Array.isArray(opts.values)) {
				for (var i = 0; i < opts.values.length; i++) {
					html += "<option value=\"" + (opts.values[i]) + "\" " + (opts.values[i] === opts.value ? 'selected' : '') + ">" + (opts.values[i]) + "</option>"
				}
			}
			else {
				for (var name in opts.values) {
					html += "<option value=\"" + (opts.values[name]) + "\" " + (opts.values[name] === opts.value ? 'selected' : '') + ">" + name + "</option>"
				}
			}
			html += "</select>";

			el.innerHTML +=	html;
			break;

		case 'range':
			opts = extend({
				min: 0,
				max: 1,
				step: 0.01,
				value: .5,
				name: 'noname-range'
			}, opts);
			el.innerHTML += "<input\n\t\t\t\tid=\"" + (opts.name) + "\" type=\"range\" class=\"param-input param-range\" value=\"" + (opts.value) + "\" min=\"" + (opts.min) + "\" max=\"" + (opts.max) + "\" step=\"" + (opts.step) + "\" title=\"" + (opts.value) + "\"/>\n\t\t\t";
			break;


		case 'checkbox':
			opts = extend({
				value: false,
				name: 'noname-checkbox'
			}, opts);
			el.innerHTML += "<input\n\t\t\t\tid=\"" + (opts.name) + "\" type=\"checkbox\" class=\"param-input param-checkbox\" title=\"" + (opts.value) + "\" " + (opts.value ? 'checked' : '') + "/>\n\t\t\t";
			break;

		case 'number':
			opts = extend({
				min: 0,
				max: 1,
				step: 0.01,
				value: .5,
				name: 'noname-number'
			}, opts);
			el.innerHTML += "<input\n\t\t\t\tid=\"" + (opts.name) + "\" type=\"number\" class=\"param-input param-number\" value=\"" + (opts.value) + "\" min=\"" + (opts.min) + "\" max=\"" + (opts.max) + "\" step=\"" + (opts.step) + "\" title=\"" + (opts.value) + "\"/>\n\t\t\t";
			break;

		default:
			opts = extend({
				name: 'noname-text',
				value: ''
			}, opts);
			el.innerHTML += "<input placeholder=\"value...\" id=\"" + (opts.name) + "\" class=\"param-input param-text\" value=\"" + (opts.value) + "\" title=\"" + (opts.value) + "\"/>\n\t\t\t";
			break;

	}

	opts.element = el;

	var self = this;
	el.querySelector('input, select').addEventListener('input', change);
	el.querySelector('input, select').addEventListener('change', change);

	opts.idx = this.paramsList.length;
	this.paramsCache[opts.name] = opts.idx;
	this.paramsList.push(opts);

	function change () {
		var v = this.type === 'checkbox' ? this.checked : (this.type === 'number' || this.type === 'range') ? parseFloat(this.value) : this.value;
		this.title = v;
		opts.value = v;
		cb && cb.call(self, v, opts);
		self.emit('change', opts.name, v, opts);
	};

	this.paramsEl.appendChild(el);

	this.updateHistory();

	return el;
};

//return value of defined param
StartApp.prototype.getParamValue = function (name) {
	var el = this.paramsEl.querySelector('#' + name.toLowerCase());

	return el && el.type === 'checkbox' ? el.checked : el && el.value;
}

StartApp.prototype.setParamValue = function (name, value) {
	var el = this.paramsEl.querySelector('#' + name.toLowerCase());

	if (!el) return;

	if (el.type === 'checkbox') {
		el.checked = !!value;
	}
	else if (el.tagName === 'SELECT') {
		el.value = value;
	}
	else {
		el.value = value;
	}

	this.paramsList[this.paramsCache[name]].value = value;
}


},{"audio-context":10,"color-parse":18,"color-space/hsl":19,"events":27,"get-float-time-domain-data":32,"inherits":37,"insert-css":38,"is-mobile":43,"is-url":45,"left-pad":46,"mutype/is-object":51,"querystring":63,"raf":65,"right-now":66,"web-audio-player":70,"xhr":79,"xtend/mutable":82}],69:[function(require,module,exports){

exports = module.exports = trim;

function trim(str){
  return str.replace(/^\s*|\s*$/g, '');
}

exports.left = function(str){
  return str.replace(/^\s*/, '');
};

exports.right = function(str){
  return str.replace(/\s*$/, '');
};

},{}],70:[function(require,module,exports){
var buffer = require('./lib/buffer-source')
var media = require('./lib/media-source')

module.exports = webAudioPlayer
function webAudioPlayer (src, opt) {
  if (!src) throw new TypeError('must specify a src parameter')
  opt = opt || {}
  if (opt.buffer) return buffer(src, opt)
  else return media(src, opt)
}

},{"./lib/buffer-source":72,"./lib/media-source":75}],71:[function(require,module,exports){
module.exports = createAudioContext
function createAudioContext () {
  var AudioCtor = window.AudioContext || window.webkitAudioContext
  return new AudioCtor()
}

},{}],72:[function(require,module,exports){
(function (process){
var canPlaySrc = require('./can-play-src')
var createAudioContext = require('./audio-context')
var xhrAudio = require('./xhr-audio')
var EventEmitter = require('events').EventEmitter
var rightNow = require('right-now')
var resume = require('./resume-context')

module.exports = createBufferSource
function createBufferSource (src, opt) {
  opt = opt || {}
  var emitter = new EventEmitter()
  var audioContext = opt.context || createAudioContext()

  // a pass-through node so user just needs to
  // connect() once
  var bufferNode, buffer, duration
  var node = audioContext.createGain()
  var audioStartTime = null
  var audioPauseTime = null
  var audioCurrentTime = 0
  var playing = false
  var loop = opt.loop

  emitter.play = function () {
    if (playing) return
    playing = true

    if (opt.autoResume !== false) resume(emitter.context)
    disposeBuffer()
    bufferNode = audioContext.createBufferSource()
    bufferNode.connect(emitter.node)
    bufferNode.onended = ended
    if (buffer) {
      // Might be null undefined if we are still loading
      bufferNode.buffer = buffer
    }
    if (loop) {
      bufferNode.loop = true
      if (typeof opt.loopStart === 'number') bufferNode.loopStart = opt.loopStart
      if (typeof opt.loopEnd === 'number') bufferNode.loopEnd = opt.loopEnd
    }

    if (duration && audioCurrentTime > duration) {
      // for when it loops...
      audioCurrentTime = audioCurrentTime % duration
    }
    var nextTime = audioCurrentTime

    bufferNode.start(0, nextTime)
    audioStartTime = rightNow()
  }

  emitter.pause = function () {
    if (!playing) return
    playing = false
    // Don't let the "end" event
    // get triggered on manual pause.
    bufferNode.onended = null
    bufferNode.stop(0)
    audioPauseTime = rightNow()
    audioCurrentTime += (audioPauseTime - audioStartTime) / 1000
  }

  emitter.stop = function () {
    emitter.pause()
    ended()
  }

  emitter.dispose = function () {
    disposeBuffer()
    buffer = null
  }

  emitter.node = node
  emitter.context = audioContext

  Object.defineProperties(emitter, {
    duration: {
      enumerable: true, configurable: true,
      get: function () {
        return duration
      }
    },
    playing: {
      enumerable: true, configurable: true,
      get: function () {
        return playing
      }
    },
    buffer: {
      enumerable: true, configurable: true,
      get: function () {
        return buffer
      }
    },
    volume: {
      enumerable: true, configurable: true,
      get: function () {
        return node.gain.value
      },
      set: function (n) {
        node.gain.value = n
      }
    }
  })

  // set initial volume
  if (typeof opt.volume === 'number') {
    emitter.volume = opt.volume
  }

  // filter down to a list of playable sources
  var sources = Array.isArray(src) ? src : [ src ]
  sources = sources.filter(Boolean)
  var playable = sources.some(canPlaySrc)
  if (playable) {
    var source = sources.filter(canPlaySrc)[0]
    // Support the same source types as in
    // MediaElement mode...
    if (typeof source.getAttribute === 'function') {
      source = source.getAttribute('src')
    } else if (typeof source.src === 'string') {
      source = source.src
    }
    // We have at least one playable source.
    // For now just play the first,
    // ideally this module could attempt each one.
    startLoad(source)
  } else {
    // no sources can be played...
    process.nextTick(function () {
      emitter.emit('error', canPlaySrc.createError(sources))
    })
  }
  return emitter

  function startLoad (src) {
    xhrAudio(audioContext, src, function audioDecoded (err, decoded) {
      if (err) return emitter.emit('error', err)
      buffer = decoded // store for later use
      if (bufferNode) {
        // if play() was called early
        bufferNode.buffer = buffer
      }
      duration = buffer.duration
      node.buffer = buffer
      emitter.emit('load')
    }, function audioProgress (amount, total) {
      emitter.emit('progress', amount, total)
    }, function audioDecoding () {
      emitter.emit('decoding')
    })
  }

  function ended () {
    emitter.emit('end')
    playing = false
    audioCurrentTime = 0
  }

  function disposeBuffer () {
    if (bufferNode) bufferNode.disconnect()
  }
}

}).call(this,require('_process'))
},{"./audio-context":71,"./can-play-src":73,"./resume-context":76,"./xhr-audio":77,"_process":14,"events":27,"right-now":66}],73:[function(require,module,exports){
var lookup = require('browser-media-mime-type')
var audio

module.exports = isSrcPlayable
function isSrcPlayable (src) {
  if (!src) throw new TypeError('src cannot be empty')
  var type
  if (typeof src.getAttribute === 'function') {
    // <source> element
    type = src.getAttribute('type')
  } else if (typeof src === 'string') {
    // 'foo.mp3' string
    var ext = extension(src)
    if (ext) type = lookup(ext)
  } else {
    // { src: 'foo.mp3', type: 'audio/mpeg; codecs..'}
    type = src.type
  }

  // We have an unknown file extension or
  // a <source> tag without an explicit type,
  // just let the browser handle it!
  if (!type) return true

  // handle "no" edge case with super legacy browsers...
  // https://groups.google.com/forum/#!topic/google-web-toolkit-contributors/a8Uy0bXq1Ho
  if (!audio) audio = new window.Audio()
  var canplay = audio.canPlayType(type).replace(/no/, '')
  return Boolean(canplay)
}

module.exports.createError = createError
function createError (sources) {
  // All sources are unplayable
  var err = new Error('This browser does not support any of the following sources:\n    ' +
      sources.join(', ') + '\n' +
      'Try using an array of OGG, MP3 and WAV.')
  err.type = 'AUDIO_FORMAT'
  return err
}

function extension (data) {
  var extIdx = data.lastIndexOf('.')
  if (extIdx <= 0 || extIdx === data.length - 1) {
    return undefined
  }
  return data.substring(extIdx + 1)
}

},{"browser-media-mime-type":12}],74:[function(require,module,exports){
module.exports = addOnce
function addOnce (element, event, fn) {
  function tmp (ev) {
    element.removeEventListener(event, tmp, false)
    fn(ev, element)
  }
  element.addEventListener(event, tmp, false)
}

},{}],75:[function(require,module,exports){
(function (process){
var EventEmitter = require('events').EventEmitter
var createAudio = require('simple-media-element').audio
var assign = require('object-assign')

var resume = require('./resume-context')
var createAudioContext = require('./audio-context')
var canPlaySrc = require('./can-play-src')
var addOnce = require('./event-add-once')

module.exports = createMediaSource
function createMediaSource (src, opt) {
  opt = assign({}, opt)
  var emitter = new EventEmitter()

  // Default to Audio instead of HTMLAudioElement
  // There is not much difference except in the following:
  //    x instanceof Audio
  //    x instanceof HTMLAudioElement
  // And in my experience Audio has better support on various
  // platforms like CocoonJS.
  // Please open an issue if there is a concern with this.
  if (!opt.element) opt.element = new window.Audio()

  var desiredVolume = opt.volume
  delete opt.volume // make sure <audio> tag receives full volume
  var audio = createAudio(src, opt)
  var audioContext = opt.context || createAudioContext()
  var node = audioContext.createGain()
  var mediaNode = audioContext.createMediaElementSource(audio)
  mediaNode.connect(node)

  audio.addEventListener('ended', function () {
    emitter.emit('end')
  })

  var loopStart = opt.loopStart
  var loopEnd = opt.loopEnd
  var hasLoopStart = typeof loopStart === 'number' && isFinite(loopStart)
  var hasLoopEnd = typeof loopEnd === 'number' && isFinite(loopEnd)
  var isLoopReady = false
  if (hasLoopStart || hasLoopEnd) {
    window.requestAnimationFrame(function update () {
      // audio hasn't been loaded yet...
      if (typeof audio.duration !== 'number') return
      var currentTime = audio.currentTime

      // where to end the buffer
      var endTime = hasLoopEnd ? Math.min(audio.duration, loopEnd) : audio.duration

      if (currentTime > (loopStart || 0)) {
        isLoopReady = true
      }

      // jump ahead to loop start point
      if (hasLoopStart && isLoopReady && currentTime < loopStart) {
        audio.currentTime = loopStart
      }

      // if we've hit the end of the buffer
      if (currentTime >= endTime) {
        // if there is no loop end point, let native looping take over
        // if we have a loop end point, jump back to start point or zero
        if (hasLoopEnd) {
          audio.currentTime = hasLoopStart ? loopStart : 0
        }
      }
      window.requestAnimationFrame(update)
    });
  }

  emitter.element = audio
  emitter.context = audioContext
  emitter.node = node
  emitter.pause = audio.pause.bind(audio)
  emitter.play = function () {
    if (opt.autoResume !== false) resume(emitter.context)
    return audio.play()
  }

  // This exists currently for parity with Buffer source
  // Open to suggestions for what this should dispose...
  emitter.dispose = function () {}

  emitter.stop = function () {
    var wasPlaying = emitter.playing
    audio.pause()
    audio.currentTime = 0
    isLoopReady = false
    if (wasPlaying) {
      emitter.emit('end')
    }
  }

  Object.defineProperties(emitter, {
    duration: {
      enumerable: true, configurable: true,
      get: function () {
        return audio.duration
      }
    },
    currentTime: {
      enumerable: true, configurable: true,
      get: function () {
        return audio.currentTime
      }
    },
    playing: {
      enumerable: true, configurable: true,
      get: function () {
        return !audio.paused
      }
    },
    volume: {
      enumerable: true, configurable: true,
      get: function () {
        return node.gain.value
      },
      set: function (n) {
        node.gain.value = n
      }
    }
  })

  // Set initial volume
  if (typeof desiredVolume === 'number') {
    emitter.volume = desiredVolume
  }

  // Check if all sources are unplayable,
  // if so we emit an error since the browser
  // might not.
  var sources = Array.isArray(src) ? src : [ src ]
  sources = sources.filter(Boolean)
  var playable = sources.some(canPlaySrc)
  if (playable) {
    // At least one source is probably/maybe playable
    startLoad()
  } else {
    // emit error on next tick so user can catch it
    process.nextTick(function () {
      emitter.emit('error', canPlaySrc.createError(sources))
    })
  }

  return emitter

  function startLoad () {
    // The file errors (like decoding / 404s) appear on <source>
    var srcElements = Array.prototype.slice.call(audio.children)
    var remainingSrcErrors = srcElements.length
    var hasErrored = false
    var sourceError = function (err, el) {
      if (hasErrored) return
      remainingSrcErrors--
      console.warn('Error loading source: ' + el.getAttribute('src'))
      if (remainingSrcErrors <= 0) {
        hasErrored = true
        srcElements.forEach(function (el) {
          el.removeEventListener('error', sourceError, false)
        })
        emitter.emit('error', new Error('Could not play any of the supplied sources'))
      }
    }

    var done = function () {
      emitter.emit('load')
    }

    if (audio.readyState >= audio.HAVE_ENOUGH_DATA) {
      process.nextTick(done)
    } else {
      addOnce(audio, 'canplay', done)
      addOnce(audio, 'error', function (ev) {
        emitter.emit(new Error('Unknown error while loading <audio>'))
      })
      srcElements.forEach(function (el) {
        addOnce(el, 'error', sourceError)
      })
    }

    // On most browsers the loading begins
    // immediately. However, on iOS 9.2 Safari,
    // you need to call load() for events
    // to be triggered.
    audio.load()
  }
}

}).call(this,require('_process'))
},{"./audio-context":71,"./can-play-src":73,"./event-add-once":74,"./resume-context":76,"_process":14,"events":27,"object-assign":53,"simple-media-element":67}],76:[function(require,module,exports){
module.exports = function (audioContext) {
  if (audioContext.state === 'suspended' &&
      typeof audioContext.resume === 'function') {
    audioContext.resume()
  }
}

},{}],77:[function(require,module,exports){
var xhr = require('xhr')
var xhrProgress = require('xhr-progress')

module.exports = xhrAudio
function xhrAudio (audioContext, src, cb, progress, decoding) {
  var xhrObject = xhr({
    uri: src,
    responseType: 'arraybuffer'
  }, function (err, resp, arrayBuf) {
    if (!/^2/.test(resp.statusCode)) {
      err = new Error('status code ' + resp.statusCode + ' requesting ' + src)
    }
    if (err) return cb(err)
    decode(arrayBuf)
  })

  xhrProgress(xhrObject)
    .on('data', function (amount, total) {
      progress(amount, total)
    })

  function decode (arrayBuf) {
    decoding()
    audioContext.decodeAudioData(arrayBuf, function (decoded) {
      cb(null, decoded)
    }, function () {
      var err = new Error('Error decoding audio data')
      err.type = 'DECODE_AUDIO_DATA'
      cb(err)
    })
  }
}

},{"xhr":79,"xhr-progress":78}],78:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter

module.exports = progress

function progress(xhr) {
  var emitter = new EventEmitter
  var finished = false

  if (xhr.attachEvent) {
    xhr.attachEvent('onreadystatechange', done)
    return emitter
  }

  xhr.addEventListener('load', done, false)
  xhr.addEventListener('progress', progress, false)
  function progress(event) {
    var value = event.lengthComputable
      ? event.loaded / event.total
      : 0

    if (!finished) emitter.emit('data'
      , value
      , event.total || null
    )

    finished = value === 1
  }

  function done(event) {
    if (event.type !== 'load' && !/^(ready|complete)$/g.test(
      (event.currentTarget || event.srcElement).readyState
    )) return

    if (finished) return
    if (xhr.removeEventListener) {
      xhr.removeEventListener('load', done, false)
      xhr.removeEventListener('progress', progress, false)
    } else
    if (xhr.detatchEvent) {
      xhr.detatchEvent('onreadystatechange', done)
    }

    emitter.emit('data', 1, event.total || null)
    emitter.emit('done')
    finished = true
  }

  return emitter
}

},{"events":27}],79:[function(require,module,exports){
"use strict";
var window = require("global/window")
var isFunction = require("is-function")
var parseHeaders = require("parse-headers")
var xtend = require("xtend")

module.exports = createXHR
createXHR.XMLHttpRequest = window.XMLHttpRequest || noop
createXHR.XDomainRequest = "withCredentials" in (new createXHR.XMLHttpRequest()) ? createXHR.XMLHttpRequest : window.XDomainRequest

forEachArray(["get", "put", "post", "patch", "head", "delete"], function(method) {
    createXHR[method === "delete" ? "del" : method] = function(uri, options, callback) {
        options = initParams(uri, options, callback)
        options.method = method.toUpperCase()
        return _createXHR(options)
    }
})

function forEachArray(array, iterator) {
    for (var i = 0; i < array.length; i++) {
        iterator(array[i])
    }
}

function isEmpty(obj){
    for(var i in obj){
        if(obj.hasOwnProperty(i)) return false
    }
    return true
}

function initParams(uri, options, callback) {
    var params = uri

    if (isFunction(options)) {
        callback = options
        if (typeof uri === "string") {
            params = {uri:uri}
        }
    } else {
        params = xtend(options, {uri: uri})
    }

    params.callback = callback
    return params
}

function createXHR(uri, options, callback) {
    options = initParams(uri, options, callback)
    return _createXHR(options)
}

function _createXHR(options) {
    if(typeof options.callback === "undefined"){
        throw new Error("callback argument missing")
    }

    var called = false
    var callback = function cbOnce(err, response, body){
        if(!called){
            called = true
            options.callback(err, response, body)
        }
    }

    function readystatechange() {
        if (xhr.readyState === 4) {
            setTimeout(loadFunc, 0)
        }
    }

    function getBody() {
        // Chrome with requestType=blob throws errors arround when even testing access to responseText
        var body = undefined

        if (xhr.response) {
            body = xhr.response
        } else {
            body = xhr.responseText || getXml(xhr)
        }

        if (isJson) {
            try {
                body = JSON.parse(body)
            } catch (e) {}
        }

        return body
    }

    function errorFunc(evt) {
        clearTimeout(timeoutTimer)
        if(!(evt instanceof Error)){
            evt = new Error("" + (evt || "Unknown XMLHttpRequest Error") )
        }
        evt.statusCode = 0
        return callback(evt, failureResponse)
    }

    // will load the data & process the response in a special response object
    function loadFunc() {
        if (aborted) return
        var status
        clearTimeout(timeoutTimer)
        if(options.useXDR && xhr.status===undefined) {
            //IE8 CORS GET successful response doesn't have a status field, but body is fine
            status = 200
        } else {
            status = (xhr.status === 1223 ? 204 : xhr.status)
        }
        var response = failureResponse
        var err = null

        if (status !== 0){
            response = {
                body: getBody(),
                statusCode: status,
                method: method,
                headers: {},
                url: uri,
                rawRequest: xhr
            }
            if(xhr.getAllResponseHeaders){ //remember xhr can in fact be XDR for CORS in IE
                response.headers = parseHeaders(xhr.getAllResponseHeaders())
            }
        } else {
            err = new Error("Internal XMLHttpRequest Error")
        }
        return callback(err, response, response.body)
    }

    var xhr = options.xhr || null

    if (!xhr) {
        if (options.cors || options.useXDR) {
            xhr = new createXHR.XDomainRequest()
        }else{
            xhr = new createXHR.XMLHttpRequest()
        }
    }

    var key
    var aborted
    var uri = xhr.url = options.uri || options.url
    var method = xhr.method = options.method || "GET"
    var body = options.body || options.data
    var headers = xhr.headers = options.headers || {}
    var sync = !!options.sync
    var isJson = false
    var timeoutTimer
    var failureResponse = {
        body: undefined,
        headers: {},
        statusCode: 0,
        method: method,
        url: uri,
        rawRequest: xhr
    }

    if ("json" in options && options.json !== false) {
        isJson = true
        headers["accept"] || headers["Accept"] || (headers["Accept"] = "application/json") //Don't override existing accept header declared by user
        if (method !== "GET" && method !== "HEAD") {
            headers["content-type"] || headers["Content-Type"] || (headers["Content-Type"] = "application/json") //Don't override existing accept header declared by user
            body = JSON.stringify(options.json === true ? body : options.json)
        }
    }

    xhr.onreadystatechange = readystatechange
    xhr.onload = loadFunc
    xhr.onerror = errorFunc
    // IE9 must have onprogress be set to a unique function.
    xhr.onprogress = function () {
        // IE must die
    }
    xhr.onabort = function(){
        aborted = true;
    }
    xhr.ontimeout = errorFunc
    xhr.open(method, uri, !sync, options.username, options.password)
    //has to be after open
    if(!sync) {
        xhr.withCredentials = !!options.withCredentials
    }
    // Cannot set timeout with sync request
    // not setting timeout on the xhr object, because of old webkits etc. not handling that correctly
    // both npm's request and jquery 1.x use this kind of timeout, so this is being consistent
    if (!sync && options.timeout > 0 ) {
        timeoutTimer = setTimeout(function(){
            if (aborted) return
            aborted = true//IE9 may still call readystatechange
            xhr.abort("timeout")
            var e = new Error("XMLHttpRequest timeout")
            e.code = "ETIMEDOUT"
            errorFunc(e)
        }, options.timeout )
    }

    if (xhr.setRequestHeader) {
        for(key in headers){
            if(headers.hasOwnProperty(key)){
                xhr.setRequestHeader(key, headers[key])
            }
        }
    } else if (options.headers && !isEmpty(options.headers)) {
        throw new Error("Headers cannot be set on an XDomainRequest object")
    }

    if ("responseType" in options) {
        xhr.responseType = options.responseType
    }

    if ("beforeSend" in options &&
        typeof options.beforeSend === "function"
    ) {
        options.beforeSend(xhr)
    }

    // Microsoft Edge browser sends "undefined" when send is called with undefined value.
    // XMLHttpRequest spec says to pass null as body to indicate no body
    // See https://github.com/naugtur/xhr/issues/100.
    xhr.send(body || null)

    return xhr


}

function getXml(xhr) {
    if (xhr.responseType === "document") {
        return xhr.responseXML
    }
    var firefoxBugTakenEffect = xhr.responseXML && xhr.responseXML.documentElement.nodeName === "parsererror"
    if (xhr.responseType === "" && !firefoxBugTakenEffect) {
        return xhr.responseXML
    }

    return null
}

function noop() {}

},{"global/window":80,"is-function":42,"parse-headers":54,"xtend":81}],80:[function(require,module,exports){
(function (global){
var win;

if (typeof window !== "undefined") {
    win = window;
} else if (typeof global !== "undefined") {
    win = global;
} else if (typeof self !== "undefined"){
    win = self;
} else {
    win = {};
}

module.exports = win;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],81:[function(require,module,exports){
module.exports = extend

var hasOwnProperty = Object.prototype.hasOwnProperty;

function extend() {
    var arguments$1 = arguments;

    var target = {}

    for (var i = 0; i < arguments.length; i++) {
        var source = arguments$1[i]

        for (var key in source) {
            if (hasOwnProperty.call(source, key)) {
                target[key] = source[key]
            }
        }
    }

    return target
}

},{}],82:[function(require,module,exports){
module.exports = extend

var hasOwnProperty = Object.prototype.hasOwnProperty;

function extend(target) {
    var arguments$1 = arguments;

    for (var i = 1; i < arguments.length; i++) {
        var source = arguments$1[i]

        for (var key in source) {
            if (hasOwnProperty.call(source, key)) {
                target[key] = source[key]
            }
        }
    }

    return target
}

},{}],83:[function(require,module,exports){
var startApp = require('start-app');
var Spectrogram = require('./2d');
var db = require('decibels');
var ft = require('fourier-transform');
var ctx = require('audio-context');
var colorScales = require('colormap/colorScale');
var palettes = require('nice-color-palettes/200');
var colorParse = require('color-parse');
var flatten = require('flatten');
var isMobile = require('is-mobile')();

palettes = palettes
	.map(function (palette) {
		return palette.map(function (v) {
			var parsed = colorParse(v);
			parsed.values.push(1);
			return parsed.values;
		})
	})
	.filter(function (palette) {
		var start = palette[0], end = palette[palette.length - 1];
		var leftLightness = (start[0] * 299 + start[1] * 587 + start[2] * 114) / (1000);
		var rightLightness = (end[0] * 299 + end[1] * 587 + end[2] * 114) / (1000);
		if (Math.abs(leftLightness - rightLightness) < 128) {
			return false;
		}
		return true;
	});

//playback speed
var speed = 100;

//pick random palette
var palette = palettes[0]//(Math.random() * palettes.length)|0];

//analyser
var source = null;
var analyser = ctx.createAnalyser();
analyser.fftSize = 4096;
analyser.smoothingTimeConstant = .1;
analyser.connect(ctx.destination);


//generate input sine
var N = 4096;
var sine = Array(N);
var saw = Array(N);
var noise = Array(N);
var rate = 44100;

for (var i = 0; i < N; i++) {
	sine[i] = Math.sin(10000 * Math.PI * 2 * (i / rate));
	saw[i] = 2 * ((1000 * i / rate) % 1) - 1;
	noise[i] = Math.random() * 2 - 1;
}

// var frequencies = ft(sine);
// var frequencies = Array(1024).fill(-150);
// var frequencies = ft(noise);
//NOTE: ios does not allow setting too big this value
var frequencies = new Float32Array(analyser.frequencyBinCount);
// for (var i = 0; i < frequencies.length; i++) frequencies[i] = -150;
// frequencies = frequencies.map((v) => db.fromGain(v));


var app = startApp({
	github: 'audio-lab/gl-spectrogram',
	color: palette[palette.length - 1],
	// source: 'https://soundcloud.com/xlr8r/sets/xlr8r-top-10-downloads-of-may',
	source: isMobile ? './sample.mp3' : 'https://soundcloud.com/sincopat/alberto-sola-sincopat-podcast-157',
	history: false,
	// autoplay: false
});


var spectrogram = Spectrogram({
	smoothing: .1,
	fill: palette,
	maxDecibels: 0,
	minDecibels: -100,
	// logarithmic: false,
	// autostart: false
	// weighting:
});

app.addParams({
	fill: {
		type: 'select',
		values: (function () {
			var values = {};
			for (var name in colorScales) {
				if (name === 'alpha') continue;
				if (name === 'hsv') continue;
				if (name === 'rainbow') continue;
				if (name === 'rainbow-soft') continue;
				if (name === 'phase') continue;
				values[name] = name;
			}
			return values;
		})(),
		value: 'greys',
		change: function (value, state) {
			spectrogram.setFill(value, this.getParamValue('inversed'));
			this.setColor(spectrogram.color);
		}
	},
	inversed: {
		value: false,
		change: function (value) {
			spectrogram.setFill(this.getParamValue('fill'), value);
			this.setColor(spectrogram.color);
		}
	},
	weighting: {
		values: {
			itu: 'itu',
			a: 'a',
			b: 'b',
			c: 'c',
			d: 'd',
			z: 'z'
		},
		value: spectrogram.weighting,
		change: function (v) {
			spectrogram.weighting = v;
		}
	},
	logarithmic: {
		value: spectrogram.logarithmic,
		change: function (v) {
			spectrogram.logarithmic = v;
			spectrogram.update();
		}
	},
	grid: {
		value: spectrogram.grid,
		change: function (v) {
			spectrogram.grid = v;
			spectrogram.update();
		}
	},
	// axes: spectrogram.axes,
	smoothing: {
		min: 0,
		max: 1,
		step: .01,
		value: spectrogram.smoothing,
		change: function (v) {
			spectrogram.smoothing = v;
		}
	},
	speed: {
		type: 'range',
		value: speed,
		min: 1,
		//4ms is minimal interval for HTML5 (250 times per second)
		max: 250,
		change: function (v) {
			speed = v;
		}
	},
	minDecibels: {
		type: 'range',
		value: spectrogram.minDecibels,
		min: -100,
		max: 0,
		change: function (v) {
			spectrogram.minDecibels = v;
			spectrogram.update();
		}
	},
	maxDecibels: {
		type: 'range',
		value: spectrogram.maxDecibels,
		min: -100,
		max: 0,
		change: function (v) {
			spectrogram.maxDecibels = v;
			spectrogram.update();
		}
	}
});



var pushIntervalId;
app.on('source', function (node) {
	source = node;
	source.connect(analyser);
})
.on('play', function () {
	pushChunk();
})
.on('pause', function () {
	clearInterval(pushIntervalId);
});

function pushChunk () {
	// for (var i = 0; i < N; i++) {
	// 	frequencies[i] = Math.sin(10000 * Math.PI * 2 * (i / rate));
	// }
	// frequencies = ft(frequencies).map(db.fromGain);

	analyser.getFloatFrequencyData(frequencies);
	spectrogram.push(frequencies);

	pushIntervalId = setTimeout(pushChunk, 1000 / speed);
}


},{"./2d":1,"audio-context":10,"color-parse":18,"colormap/colorScale":21,"decibels":24,"flatten":28,"fourier-transform":30,"is-mobile":43,"nice-color-palettes/200":52,"start-app":68}]},{},[83]);
