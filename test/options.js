'use strict';

const test = require('ava');
const Vinyl = require('vinyl');
const createPlugin = require('..');
const LocalizationKey = require('../lib/localization-key');
const {transformTest, transformFailsTest} = require('./utility/tests');

test('no options', t => {
    t.throws(() => createPlugin());
});

test('idTemplate', t => transformTest({
    whitelist: [{tagName: 'div'}],
    idTemplate: (x, file, knownIds) => {
        t.true(file instanceof Vinyl);
        t.true(knownIds instanceof Set);
        return `foo-${x}`
    }
}, `
    <div>Hello World!</div>
    <div></div>
`, `
    <div t="foo-0">Hello World!</div>
    <div></div>
`)(t));

test('idTemplate (return invalid id)', transformFailsTest({
    whitelist: [{tagName: 'h1'}],
    idTemplate: x => 'no!'
}, `
    <h1>foo</h1>
`, /idtemplate.*invalid id/i));

test('idTemplate (return no id)', transformFailsTest({
    whitelist: [{tagName: 'h1'}],
    idTemplate: x => 42
}, `
    <h1>foo</h1>
`, /idtemplate.*invalid id/i));

test('idTemplate (return fixed id)', transformFailsTest({
    whitelist: [{tagName: 'h1'}],
    idTemplate: () => 'foo'
}, `
    <h1>foo</h1>
    <h1>bar</h1>
`, /idtemplate.*same.*id/i));

test('idTemplate validation', t => {
    t.throws(() => createPlugin({
        whitelist: [],
        idTemplate: 'foo'
    }));
});

test('whitelist validation', t => {
    t.throws(() => createPlugin({}));
    t.throws(() => createPlugin({whitelist: {}}));
    t.throws(() => createPlugin({whitelist: ['foo']}));
    t.throws(() => createPlugin({whitelist: [{tagName: 42}]}));
    t.throws(() => createPlugin({whitelist: [{tagName: 'foo', attrs: {}}]}));
    t.throws(() => createPlugin({whitelist: [{tagName: 'foo', content: 'foo'}]}));
});

test('keyAttribute', transformTest({
    whitelist: [{tagName: 'h1'}],
    keyAttribute: 'foo'
}, `
    <h1>bar</h1>
`, `
    <h1 foo="t0">bar</h1>
`));

test('exceptions validation', t => {
	t.throws(() => createPlugin({exceptions: {foo: 'bar'}}));
});

test('LocalizationKey', transformTest({
    whitelist: [{tagName: 'div'}],
    LocalizationKey: class CustomKey extends LocalizationKey {
        format() {
            return 'bar';
        }
    }
}, `
    <div>foo</div>
`, `
    <div t="bar">foo</div>
`));
