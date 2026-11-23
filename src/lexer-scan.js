/**
 * @param {string} cjsSource
 * @param {boolean} extendedMode
 */
function parseSource (cjsSource, extendedMode) {
  source = cjsSource;
  pos = -1;
  end = source.length - 1;
  let ch = 0;
  let targetFirst = -1, moduleFirst = -1, factoryDepth = -1;

  // Handle #!
  if (source.charCodeAt(0) === 35/*#*/ && source.charCodeAt(1) === 33/*!*/) {
    if (source.length === 2)
      return true;
    pos += 2;
    while (pos++ < end) {
      ch = source.charCodeAt(pos);
      if (ch === 10/*\n*/ || ch === 13/*\r*/)
        break;
    }
  }

  while (pos++ < end) {
    ch = source.charCodeAt(pos);

    if (ch === 32 || ch < 14 && ch > 8)
      continue;

    if (extendedMode && (ch === 95 || ch === targetFirst || ch === moduleFirst) &&
        keywordStart(pos) && readWebpackToken(ch, factoryDepth)) {
      skipTokenRun();
      lastTokenPos = pos;
      continue;
    }

    if (openTokenDepth === 0 || extendedMode && factoryDepth === openTokenDepth) {
      switch (ch) {
        case 105/*i*/:
          if (source.startsWith('mport', pos + 1) && keywordStart(pos))
            throwIfImportStatement();
          skipTokenRun();
          lastTokenPos = pos;
          continue;
        case 114/*r*/:
          const startPos = pos;
          if (tryParseRequire(Import) && keywordStart(startPos))
            tryBacktrackAddStarExportBinding(startPos - 1);
          skipTokenRun();
          lastTokenPos = pos;
          continue;
        case 95/*_*/:
          if (source.startsWith('interopRequireWildcard', pos + 1) && (keywordStart(pos) || source.charCodeAt(pos - 1) === 46/*.*/)) {
            const startPos = pos;
            pos += 23;
            if (source.charCodeAt(pos) === 40/*(*/) {
              pos++;
              pushOpenToken(lastTokenPos);
              if (tryParseRequire(Import) && keywordStart(startPos)) {
                tryBacktrackAddStarExportBinding(startPos - 1);
              }
            }
          }
          else if (source.startsWith('_export', pos + 1) && (keywordStart(pos) || source.charCodeAt(pos - 1) === 46/*.*/)) {
            pos += 8;
            if (source.startsWith('Star', pos))
              pos += 4;
            if (source.charCodeAt(pos) === 40/*(*/) {
              pushOpenToken(lastTokenPos);
              if (source.charCodeAt(pos + 1) === 114/*r*/) {
                pos++;
                tryParseRequire(ExportStar);
              }
            }
          }
          skipTokenRun();
          lastTokenPos = pos;
          continue;
      }
    }

    switch (ch) {
      case 101/*e*/:
        if (source.startsWith('xport', pos + 1) && keywordStart(pos)) {
          if (source.charCodeAt(pos + 6) === 115/*s*/) {
            const start = pos;
            if (!tryParseExportsDotAssign(false) && extendedMode && webpack?.inline && !webpack.current &&
                start >= webpackTrustedEnd && !isIdentifierChar(source.codePointAt(start + 7), true)) {
              if (readWebpackExportsAlias(start)) webpack.alias = true;
              else if (webpack.alias) webpack.invalid = true;
            }
          }
          else if (openTokenDepth === 0)
            throwIfExportStatement();
        }
        skipTokenRun();
        break;
      case 99/*c*/:
        if (source.charCodeAt(pos + 1) === 108/*l*/ && keywordStart(pos) &&
            source.startsWith('ass', pos + 2) && isBrOrWs(source.charCodeAt(pos + 5)))
          nextBraceIsClass = true;
        skipTokenRun();
        break;
      case 109/*m*/:
        if (source.startsWith('odule', pos + 1) && keywordStart(pos))
          tryParseModuleExportsDotAssign();
        skipTokenRun();
        break;
      case 79/*O*/:
        if (source.startsWith('bject', pos + 1) && keywordStart(pos))
          tryParseObjectDefineOrKeys(openTokenDepth === 0 || extendedMode &&
            (webpack?.current ? factoryDepth === openTokenDepth : webpack?.inline));
        skipTokenRun();
        break;
      case 40/*(*/:
        pushOpenToken(lastTokenPos);
        break;
      case 91/*[*/:
        if (extendedMode) {
          pushOpenToken(lastTokenPos);
          if (pos === webpackArrayPos) {
            webpackArrayPos = -1;
            readWebpackArrayElement(WebpackArrayKeyToken);
          }
        }
        break;
      case 93/*]*/:
        if (extendedMode) {
          if (openTokenDepth === 0) throw new Error('Unexpected closing bracket.');
          openTokenDepth--;
        }
        break;
      case 44/*,*/:
        if (extendedMode && openTokenDepth) {
          const token = openTokenTypeStack[openTokenDepth - 1];
          if (token & WebpackTableToken) readWebpackFactory();
          if (token & ExportObjectToken) readExportProperty();
          if (token >= WebpackArrayKeyToken) readWebpackArrayElement(token);
        }
        break;
      case 41/*)*/:
        if (openTokenDepth === 0)
          throw new Error('Unexpected closing bracket.');
        openTokenDepth--;
        break;
      case 123/*{*/:
        pushOpenToken(lastTokenPos);
        openTokenTypeStack[openTokenDepth - 1] = nextBraceIsClass ? ClassToken : 0;
        nextBraceIsClass = false;
        if (extendedMode && pos === exportObjectPos) {
          openTokenTypeStack[openTokenDepth - 1] |= ExportObjectToken;
          exportObjectPos = -1;
          readExportProperty();
        }
        if (extendedMode && pos === webpack?.tablePos) {
          openTokenTypeStack[openTokenDepth - 1] |= WebpackTableToken;
          readWebpackFactory();
        }
        else if (extendedMode && pos === webpack?.factoryPos) {
          webpack.current = webpack.pending;
          targetFirst = webpack.current.target?.charCodeAt(0) ?? -1;
          moduleFirst = webpack.current.module?.charCodeAt(0) ?? -1;
          factoryDepth = openTokenDepth;
          _exports = webpack.current.exports ??= new Set();
          reexports = webpack.current.reexports ??= new Set();
          starExportMap = Object.create(null);
        }
        break;
      case 125/*}*/:
        if (openTokenDepth === 0)
          throw new Error('Unexpected closing brace.');
        if (extendedMode && factoryDepth === openTokenDepth) {
          webpack.current = undefined;
          targetFirst = moduleFirst = factoryDepth = -1;
          _exports = webpack.exports;
          reexports = webpack.reexports;
          starExportMap = webpack.starExportMap;
        }
        if (openTokenDepth-- === templateDepth) {
          templateDepth = templateStack[--templateStackDepth];
          templateString();
        }
        else {
          if (templateDepth !== -1 && openTokenDepth < templateDepth)
            throw new Error('Unexpected closing brace.');
        }
        break;
      case 60/*>*/:
        // TODO: <!-- XML comment support
        break;
      case 39/*'*/:
      case 34/*"*/:
        stringLiteral(ch);
        break;
      case 47/*/*/: {
        const next_ch = source.charCodeAt(pos + 1);
        if (next_ch === 47/*/*/) {
          lineComment();
          // dont update lastToken
          continue;
        }
        else if (next_ch === 42/***/) {
          blockComment();
          // dont update lastToken
          continue;
        }
        else {
          // Division / regex ambiguity handling based on checking backtrack analysis of:
          // - what token came previously (lastToken)
          // - if a closing brace or paren, what token came before the corresponding
          //   opening brace or paren (lastOpenTokenIndex)
          const lastToken = source.charCodeAt(lastTokenPos);
          if (isExpressionPunctuator(lastToken) &&
              !(lastToken === 46/*.*/ && (source.charCodeAt(lastTokenPos - 1) >= 48/*0*/ && source.charCodeAt(lastTokenPos - 1) <= 57/*9*/)) &&
              !(lastToken === 43/*+*/ && source.charCodeAt(lastTokenPos - 1) === 43/*+*/) && !(lastToken === 45/*-*/ && source.charCodeAt(lastTokenPos - 1) === 45/*-*/) ||
              lastToken === 41/*)*/ && isParenKeyword(openTokenPosStack[openTokenDepth]) ||
              lastToken === 125/*}*/ && (isExpressionTerminator(openTokenPosStack[openTokenDepth]) ||
              (openTokenTypeStack[openTokenDepth] & ClassToken) ||
              extendedMode && isStatementBrace(openTokenPosStack[openTokenDepth], openTokenDepth)) ||
              lastToken === 47/*/*/ && lastSlashWasDivision ||
              isExpressionKeyword(lastTokenPos) ||
              !lastToken) {
            regularExpression();
            lastSlashWasDivision = false;
          }
          else {
            lastSlashWasDivision = true;
          }
        }
        break;
      }
      case 96/*`*/:
        templateString();
        break;
      default:
        if (isTokenRunChar(ch))
          skipTokenRun();
    }
    lastTokenPos = pos;
  }

  if (templateDepth !== -1)
    throw new Error('Unterminated template.');

  if (openTokenDepth)
    throw new Error('Unterminated braces.');
}
