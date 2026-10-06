// OWNER: ui-shell agent. All overlay CSS, concatenated in cascade order, adopted into the shadow root.
import tokens from './tokens.css';
import base from './base.css';
import shell from './shell.css';
import editor from '../detail/editor.css';
import response from '../response/response.css';
import initiatorCss from '../detail/initiator.css';
import exportCss from '../export/export.css';
import setupsCss from '../setups/setups.css';
// xterm.js's own stylesheet (the embedded Claude Code terminal), then ours on top.
import xtermCss from '@xterm/xterm/css/xterm.css';
import terminalCss from '../terminal/terminal.css';
import wsCss from '../ws/ws.css';
import rnCss from '../rn/rn.css';
import railCss from '../rail/rail.css';
import languageCss from '../language/language.css';
import errorsCss from '../errors/errors.css';
import findCss from '../find/find.css';

export const ALL_CSS = [tokens, base, shell, editor, response, initiatorCss, exportCss, setupsCss, xtermCss, terminalCss, wsCss, rnCss, railCss, languageCss, errorsCss, findCss].join('\n');
