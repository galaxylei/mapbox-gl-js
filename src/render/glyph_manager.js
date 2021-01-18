// @flow

import loadGlyphRange from '../style/load_glyph_range';

import TinySDF from '@mapbox/tiny-sdf';
import isChar from '../util/is_char_in_unicode_block';
import {asyncAll} from '../util/util';
import {AlphaImage} from '../util/image';

import type {StyleGlyph} from '../style/style_glyph';
import type {RequestManager} from '../util/mapbox';
import type {Callback} from '../types/callback';

export const SDF_SCALE = 2;

type Entry = {
    // null means we've requested the range, but the glyph wasn't included in the result.
    glyphs: {[id: number]: StyleGlyph | null},
    requests: {[range: number]: Array<Callback<{[_: number]: StyleGlyph | null}>>},
    ranges: {[range: number]: boolean | null},
    tinySDF?: TinySDF
};

export const LocalGlyphMode = {
    none: 0,
    ideographs: 1,
    all: 2
};

class GlyphManager {
    requestManager: RequestManager;
    localFontFamily: ?string;
    localGlyphMode: number;
    entries: {[_: string]: Entry};
    // Multiple fontstacks may share the same local glyphs, so keep an index
    // into the glyphs based soley on font weight
    localGlyphs: {[_: string]: {[id: number]: StyleGlyph | null}};
    url: ?string;

    // exposed as statics to enable stubbing in unit tests
    static loadGlyphRange: typeof loadGlyphRange;
    static TinySDF: Class<TinySDF>;

    constructor(requestManager: RequestManager, localGlyphMode: number, localFontFamily: ?string) {
        this.requestManager = requestManager;
        this.localGlyphMode = localGlyphMode;
        this.localFontFamily = localFontFamily;
        this.entries = {};
        this.localGlyphs = {
            // Only these four font weights are supported
            '200': {},
            '400': {},
            '500': {},
            '900': {}
        };
    }

    setURL(url: ?string) {
        this.url = url;
    }

    getGlyphs(glyphs: {[stack: string]: Array<number>}, callback: Callback<{[stack: string]: {[id: number]: ?StyleGlyph}}>) {
        const all = [];

        for (const stack in glyphs) {
            for (const id of glyphs[stack]) {
                all.push({stack, id});
            }
        }

        asyncAll(all, ({stack, id}, callback: Callback<{stack: string, id: number, glyph: ?StyleGlyph}>) => {
            let entry = this.entries[stack];
            if (!entry) {
                entry = this.entries[stack] = {
                    glyphs: {},
                    requests: {},
                    ranges: {}
                };
            }

            let glyph = entry.glyphs[id];
            if (glyph !== undefined) {
                callback(null, {stack, id, glyph});
                return;
            }

            glyph = this._tinySDF(entry, stack, id);
            if (glyph) {
                entry.glyphs[id] = glyph;
                callback(null, {stack, id, glyph});
                return;
            }

            const range = Math.floor(id / 256);
            if (range * 256 > 65535) {
                callback(new Error('glyphs > 65535 not supported'));
                return;
            }

            if (entry.ranges[range]) {
                callback(null, {stack, id, glyph});
                return;
            }

            let requests = entry.requests[range];
            if (!requests) {
                requests = entry.requests[range] = [];
                GlyphManager.loadGlyphRange(stack, range, (this.url: any), this.requestManager,
                    (err, response: ?{[_: number]: StyleGlyph | null}) => {
                        if (response) {
                            for (const id in response) {
                                if (!this._doesCharSupportLocalGlyph(+id)) {
                                    entry.glyphs[+id] = response[+id];
                                }
                            }
                            entry.ranges[range] = true;
                        }
                        for (const cb of requests) {
                            cb(err, response);
                        }
                        delete entry.requests[range];
                    });
            }

            requests.push((err, result: ?{[_: number]: StyleGlyph | null}) => {
                if (err) {
                    callback(err);
                } else if (result) {
                    callback(null, {stack, id, glyph: result[id] || null});
                }
            });
        }, (err, glyphs: ?Array<{stack: string, id: number, glyph: ?StyleGlyph}>) => {
            if (err) {
                callback(err);
            } else if (glyphs) {
                const result = {};

                for (const {stack, id, glyph} of glyphs) {
                    // Clone the glyph so that our own copy of its ArrayBuffer doesn't get transferred.
                    (result[stack] || (result[stack] = {}))[id] = glyph && {
                        id: glyph.id,
                        bitmap: glyph.bitmap.clone(),
                        metrics: glyph.metrics
                    };
                }

                callback(null, result);
            }
        });
    }

    _doesCharSupportLocalGlyph(id: number): boolean {
        if (this.localGlyphMode === LocalGlyphMode.none) {
            return false;
        } else if (this.localGlyphMode === LocalGlyphMode.all) {
            return !!this.localFontFamily;
        } else {
            /* eslint-disable new-cap */
            return !!this.localFontFamily &&
            (isChar['CJK Unified Ideographs'](id) ||
                isChar['Hangul Syllables'](id) ||
                isChar['Hiragana'](id) ||
                isChar['Katakana'](id));
            /* eslint-enable new-cap */
        }
    }

    _tinySDF(entry: Entry, stack: string, id: number): ?StyleGlyph {
        const family = this.localFontFamily;
        if (!family) {
            return;
        }

        if (!this._doesCharSupportLocalGlyph(id)) {
            return;
        }

        let tinySDF = entry.tinySDF;
        const sdfBuffer = 3 * SDF_SCALE;
        if (!tinySDF) {
            let fontWeight = '400';
            if (/bold/i.test(stack)) {
                fontWeight = '900';
            } else if (/medium/i.test(stack)) {
                fontWeight = '500';
            } else if (/light/i.test(stack)) {
                fontWeight = '200';
            }
            tinySDF = entry.tinySDF = new GlyphManager.TinySDF(24 * SDF_SCALE, sdfBuffer, 8 * SDF_SCALE, .25, family, fontWeight);
        }

        if (this.localGlyphs[tinySDF.fontWeight][id]) {
            return this.localGlyphs[tinySDF.fontWeight][id];
        }

        const sdfWithMetrics = tinySDF.drawWithMetrics(String.fromCharCode(id));
        const metrics = sdfWithMetrics.metrics;
        const baselineAdjustment = 8 -
            (metrics.fontAscent ? (17 - metrics.fontAscent / SDF_SCALE) : 0); // Adjusting to match DEFAULT_OFFSET in shaping.js

        const glyph = this.localGlyphs[tinySDF.fontWeight][id] = {
            id,
            bitmap: new AlphaImage({
                width: metrics.sdfWidth,
                height: metrics.sdfHeight
            }, sdfWithMetrics.data),
            metrics: {
                width: metrics.width / SDF_SCALE,
                height: metrics.height / SDF_SCALE,
                left: metrics.left / SDF_SCALE,
                top: metrics.top / SDF_SCALE - baselineAdjustment,
                advance: metrics.advance / SDF_SCALE,
                localGlyph: true
            }
        };
        return glyph;
    }
}

GlyphManager.loadGlyphRange = loadGlyphRange;
GlyphManager.TinySDF = TinySDF;

export default GlyphManager;
