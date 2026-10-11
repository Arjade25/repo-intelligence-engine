// Bundler asset imports: no .ts module behind them, and none can sit on an import
// cycle. Neither unresolved-import check may flag them (element-web has 46).
// @ts-expect-error - no module declaration for assets in this fixture
import logo from "./logo.svg";
// @ts-expect-error - same, with a bundler query suffix
import Icon from "./icon.svg?react";
import "./styles.css";
import "./theme.pcss";
// @ts-expect-error - a code file loaded as text by the bundler, not as a module
import source from "./worker.js?raw";

export const assets = [logo, Icon, source];
