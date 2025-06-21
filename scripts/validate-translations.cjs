#!/usr/bin/env node

/**
 * Translation Validator Script
 *
 * This script validates that all language YAML files in src/localization/
 * have the same structure and keys. It helps ensure translation completeness
 * and consistency across all supported languages.
 *
 * Usage: node scripts/validate-translations.js
 */

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const LOCALIZATION_DIR = require('../src/localization/self_path.cjs')

/**
 * Recursively extracts all keys from a nested object
 */
function extractKeys(obj, prefix = '') {
  const keys = []

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...extractKeys(value, fullKey))
    } else {
      keys.push(fullKey)
    }
  }

  return keys.sort()
}

/**
 * Loads and parses a YAML file
 */
function loadYamlFile(filename) {
  const filePath = path.join(LOCALIZATION_DIR, filename)

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return yaml.load(content, { schema: yaml.DEFAULT_SCHEMA })
  } catch (error) {
    throw new Error(`Failed to parse ${filename}: ${error.message}`)
  }
}

/**
 * Gets all .yaml files in the localization directory
 */
function getYamlFiles() {
  try {
    const files = fs.readdirSync(LOCALIZATION_DIR)
    return files.filter(file => file.endsWith('.yaml')).sort()
  } catch (error) {
    throw new Error(`Failed to read localization directory: ${error.message}`)
  }
}

/**
 * Validates that all translation files have the same keys
 */
function validateTranslations() {
  console.log('🔍 Validating translation files...\n')

  const yamlFiles = getYamlFiles()

  if (yamlFiles.length === 0) {
    console.error('❌ No YAML files found in localization directory')
    return false
  }

  console.log(`📁 Found ${yamlFiles.length} YAML files: ${yamlFiles.join(', ')}\n`)

  const fileData = {}
  const allKeys = {}

  // Load all YAML files and extract their keys
  for (const file of yamlFiles) {
    try {
      console.log(`📄 Loading ${file}...`)
      const data = loadYamlFile(file)
      const keys = extractKeys(data)

      fileData[file] = data
      allKeys[file] = new Set(keys)

      console.log(`   ✅ Found ${keys.length} translation keys`)
    } catch (error) {
      console.error(`   ❌ Error loading ${file}: ${error.message}`)
      return false
    }
  }

  console.log('')

  // Use English as the reference (it should be the most complete)
  const referenceFile = 'en.yaml'
  const referenceKeys = allKeys[referenceFile]

  if (!referenceKeys) {
    console.error(`❌ Reference file ${referenceFile} not found or invalid`)
    return false
  }

  console.log(`📋 Using ${referenceFile} as reference (${referenceKeys.size} keys)\n`)

  let hasErrors = false

  // Compare each file against the reference
  for (const file of yamlFiles) {
    if (file === referenceFile) continue

    const currentKeys = allKeys[file]
    const missingKeys = [...referenceKeys].filter(key => !currentKeys.has(key))
    const extraKeys = [...currentKeys].filter(key => !referenceKeys.has(key))

    console.log(`🔍 Checking ${file}:`)

    if (missingKeys.length === 0 && extraKeys.length === 0) {
      console.log(`   ✅ Perfect match! All ${currentKeys.size} keys present\n`)
    } else {
      hasErrors = true

      if (missingKeys.length > 0) {
        console.log(`   ⚠️  Missing ${missingKeys.length} keys:`)
        missingKeys.slice(0, 10).forEach(key => console.log(`      - ${key}`))
        if (missingKeys.length > 10) {
          console.log(`      ... and ${missingKeys.length - 10} more`)
        }
      }

      if (extraKeys.length > 0) {
        console.log(`   ⚠️  Extra ${extraKeys.length} keys:`)
        extraKeys.slice(0, 10).forEach(key => console.log(`      + ${key}`))
        if (extraKeys.length > 10) {
          console.log(`      ... and ${extraKeys.length - 10} more`)
        }
      }

      console.log('')
    }
  }

  // Summary
  if (hasErrors) {
    console.log('❌ Translation validation failed!')
    console.log('   Some files are missing keys or have extra keys.')
    console.log('   Please ensure all translation files have the same structure.\n')
  } else {
    console.log('✅ Translation validation passed!')
    console.log('   All files have matching keys and structure.\n')
  }

  return !hasErrors
}

/**
 * Main execution
 */
function main() {
  try {
    console.log('🌍 Translation Validator for Polly Chrome Extension\n')

    // Check if localization directory exists
    if (!fs.existsSync(LOCALIZATION_DIR)) {
      console.error(`❌ Localization directory not found: ${LOCALIZATION_DIR}`)
      process.exit(1)
    }

    // Run validation
    const success = validateTranslations()

    // Exit with appropriate code
    process.exit(success ? 0 : 1)

  } catch (error) {
    console.error(`❌ Unexpected error: ${error.message}`)
    process.exit(1)
  }
}

// Run if called directly
if (require.main === module) {
  main()
}

module.exports = { validateTranslations, extractKeys }