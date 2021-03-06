'use strict';

const PluginError = require('plugin-error');
const {parseFragment} = require('parse5');
const {name: packageName} = require('./package.json');
const transform = require('./lib/transform');
const contentsToString = require('./lib/contents-to-string');
const createDomUtility = require('./lib/dom');
const DomRelatedError = require('./lib/dom-related-error');
const DefaultLocalizationKey = require('./lib/localization-key');
const IgnoreMap = require('./lib/ignore-map');
const mergeOptions = require('./lib/merge-options');
const prefixFilename = require('./lib/prefix-filename');
const CustomSerializer = require('./lib/custom-serializer');

const CUSTOM_TAG_NAME_REGEXP = /-/;
const LOCALIZATION_ID_REGEXP = /^[a-z0-9_.-]+$/i;

function option(value, defaultValue) {
    return value === undefined ? defaultValue : value;
}

module.exports = function (options = {}) {
    // Normalize plugin options:
    const encoding = option(options.encoding, 'utf8');
	const keyAttribute = option(options.keyAttribute, 't');

    const emitCondition = option(options.emit, 'always');
    if (!['always', 'onChangeOnly'].includes(emitCondition)) {
        throw new TypeError('options.emit must be "always" or "onChangeOnly".');
	}

	const exceptions = option(options.exceptions, {});
	for (const name in exceptions) {
		if (!['throw', 'warn', 'ignore'].includes(exceptions[name])) {
			throw new TypeError(`options.exceptions.${name} must be "throw", "warn" or "ignore".`);
		}
	}

    const LocalizationKey = option(options.LocalizationKey, DefaultLocalizationKey);

    const idTemplate = option(options.idTemplate, postfix => `t${postfix}`);
    if (typeof idTemplate !== 'function') {
        throw new TypeError('options.idTemplate must be a function.');
    }

    if (!Array.isArray(options.whitelist)) {
        throw new TypeError('options.whitelist must be an array.');
    }
    const whitelist = new Map(options.whitelist.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new TypeError(`options.whitelist[${index}] must be an object.`);
        }
        if (typeof entry.tagName !== 'string') {
            throw new TypeError(`options.whitelist[${index}].tagName must be a string.`);
        }
        const attrs = option(entry.attrs, []);
        if (!(Symbol.iterator in attrs)) {
            throw new TypeError(`options.whitelist[${index}].attrs must be iterable.`);
        }
        const content = option(entry.content, CUSTOM_TAG_NAME_REGEXP.test(entry.tagName) ? false : 'text');
        if (![false, 'text', 'html'].includes(content)) {
            throw new TypeError(`options.whitelist[${index}].content must be false, "text" or "html".`)
        }
        return [entry.tagName, {attrs: new Set(attrs), content}]
    }));

    const ignore = new IgnoreMap();
    if (options.ignore) {
        ignore.use(options.ignore);
    }

    const domUtility = createDomUtility({ignore});
    const {traverse, getAttr, setAttr, deleteAttr, analyzeContent} = domUtility;

    // Return a stream to transform each file:
    return transform(async function(inFile) {
        const inContents = (await contentsToString(inFile, encoding))
            .replace(/\r\n|\r/g, '\n');

        if (/^\<\!DOCTYPE/.test(inContents)) {
            throw new PluginError(packageName, 'Html documents are not supported.');
        }
        const dom = parseFragment(inContents, {sourceCodeLocationInfo: true});

        const knownIds = new Set();
        const candidates = [];
        for (const node of traverse(dom)) {
            const {hasText, hasNonText} = analyzeContent(node);
            const whitelisted = whitelist.get(node.tagName);
            if (whitelisted) {
                if (hasText && hasNonText) {
                    throw new DomRelatedError(inFile, node, 'Tag contains both text and non-text content.');
                }
                const originalKey = LocalizationKey.fromDom(domUtility, inFile, node);
                for (const id of originalKey.ids()) {
                    knownIds.add(id);
                }
                candidates.push({node, hasText, whitelisted, originalKey});
            } else if (hasText) {
                new DomRelatedError(inFile, node, 'Non-whitelisted tag has text content.').emit(exceptions.illegalContent);
            } else if (getAttr(node, keyAttribute)) {
                new DomRelatedError(inFile, node, `Non-whitelisted tag has a ${keyAttribute} attribute.`).emit(exceptions.illegalAttribute);
            }
        }

        if (idTemplate.onFile) {
            idTemplate.onFile(inFile, knownIds);
        }

        let nextIdPostfix = 0;
        const assignedPreferredIds = new Set();
        function getOrCreateUniqueId(id) {
            if (!id || assignedPreferredIds.has(id)) {
                let lastGeneratedId;
                do {
                    id = idTemplate(nextIdPostfix, inFile, knownIds);
                    if (typeof id !== 'string' || !LOCALIZATION_ID_REGEXP.test(id)) {
                        throw new PluginError(packageName, `options.idTemplate returned an invalid id: ${id}.`);
                    }

                    if (lastGeneratedId === id) {
                        throw new PluginError(packageName, `options.idTemplate returned the same id for different postfixes: ${id}`);
                    }
                    lastGeneratedId = id;

                    nextIdPostfix++;
                } while (knownIds.has(id));
            }
            knownIds.add(id);
            assignedPreferredIds.add(id);
            return id;
        }

        for (const {node, hasText, whitelisted, originalKey} of candidates) {
            const newKey = new LocalizationKey();
            if (whitelisted.content) {
                const preferredId = originalKey.get('html') || originalKey.get('text');
                if (hasText || preferredId) {
                    newKey.set(whitelisted.content, getOrCreateUniqueId(preferredId));
                }
            } else if (originalKey.has('html') || originalKey.has('text')) {
				new DomRelatedError(inFile, node, 'Content is already localized, but not whitelisted.').emit(exceptions.illegalContent);
				if (originalKey.has('html')) {
					newKey.set('html', originalKey.get('html'));
				}
				if (originalKey.has('text')) {
					newKey.set('text', originalKey.get('text'));
				}
            } else if (hasText) {
                new DomRelatedError(inFile, node, 'Content is not whitelisted to be localized.').emit(exceptions.illegalContent);
            }
            for (const attr of whitelisted.attrs) {
                if (typeof getAttr(node, attr) === 'string') {
                    const preferredId = originalKey.get(attr);
                    newKey.set(attr, getOrCreateUniqueId(preferredId));
                }
            }
            for (const [attr] of originalKey) {
                if (attr !== 'text' && attr !== 'html' && !whitelisted.attrs.has(attr)) {
                    new DomRelatedError(inFile, node, `Attribute "${attr}" is already localized, but not whitelisted.`).emit(exceptions.illegalAttribute);
                }
            }

            if (newKey.size > 0) {
                setAttr(node, keyAttribute, newKey.format());
            } else {
                deleteAttr(node, keyAttribute);
            }
        }

        const serializer = new CustomSerializer(dom, {}, inContents);
        const outContents = serializer.serialize(dom);
        if (emitCondition === 'onChangeOnly' && outContents === inContents) {
            return;
        }

        const outFile = inFile.clone({contents: false});
        outFile.contents = Buffer.from(outContents, encoding);
        this.push(outFile);
    });
};

module.exports.mergeOptions = mergeOptions;
module.exports.prefixFilename = prefixFilename;
