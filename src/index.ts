#!/usr/bin/env node
import { createCLI } from "./cli/index.js";

const program = createCLI();
program.parse();
