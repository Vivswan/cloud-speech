import path from 'path'
import fs, { watch } from 'fs'
import { fileURLToPath } from 'url'
import generateIconsModule from './generate-icons.js'

const logger = {
  log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
  error: (message, error) => console.error(`[${new Date().toISOString()}] ${message}`, error || ''),
  warn: (message) => console.warn(`[${new Date().toISOString()}] ${message}`)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Root and dist directories
const rootDir = path.resolve(__dirname, '..')
const distDir = path.resolve(rootDir, 'dist')

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true })
}

// Generate icons using the generate-icons.js module
const generateIcons = async () => {
  try {
    logger.log('Generating icons...')
    await generateIconsModule()
    logger.log('Icons generated successfully')
  } catch (error) {
    logger.error('Error generating icons:', error.message)
  }
}

// Copy manifest file and update version from package.json
const copyManifest = async () => {
  // Read manifest file
  const manifestPath = path.resolve(rootDir, 'manifest.js')
  const manifest = (await import(manifestPath)).default

  // Read package.json to get version
  const packagePath = path.resolve(rootDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))

  // Update manifest version with package.json version
  manifest.version = packageJson.version
  delete manifest['_comment']

  // Write updated manifest
  fs.writeFileSync(
    path.resolve(distDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  )
  logger.log(`Updated manifest.json with version ${packageJson.version} and copied to dist directory`)
}

// Process Tailwind CSS and copy assets
const copyAssets = async () => {
  // Process Tailwind CSS
  const processTailwindCSS = async () => {
    try {
      const tailwind = (await import('tailwindcss')).default
      const postcss = (await import('postcss')).default

      const inputCSS = fs.readFileSync(path.join(rootDir, 'src/assets/css/styles.css'), 'utf8')

      const result = await postcss([tailwind])
        .process(inputCSS, {
          from: path.join(rootDir, 'src/assets/css/styles.css'),
          to: path.join(distDir, 'css/styles.css')
        })

      // Ensure CSS directory exists
      const cssDir = path.join(distDir, 'css')
      if (!fs.existsSync(cssDir)) {
        fs.mkdirSync(cssDir, { recursive: true })
      }

      fs.writeFileSync(path.join(distDir, 'css/styles.css'), result.css)
      logger.log('Processed Tailwind CSS')
    } catch (error) {
      logger.error('Error processing Tailwind CSS:', error)
      // Fallback: copy CSS file as-is
      const cssDir = path.join(distDir, 'css')
      if (!fs.existsSync(cssDir)) {
        fs.mkdirSync(cssDir, { recursive: true })
      }
      fs.copyFileSync(
        path.join(rootDir, 'src/assets/css/styles.css'),
        path.join(distDir, 'css/styles.css')
      )
      logger.log('Copied CSS file without processing (Tailwind processing failed)')
    }
  }

  await processTailwindCSS()

  // Copy image files
  const copyDirRecursive = (srcDir, destDir) => {
    // Create destination directory if it doesn't exist
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }

    // Read directory contents
    const entries = fs.readdirSync(srcDir, { withFileTypes: true })

    // Process each entry
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name)
      const destPath = path.join(destDir, entry.name)

      if (entry.isDirectory()) {
        // Recursively copy subdirectory
        copyDirRecursive(srcPath, destPath)
      } else if (!srcPath.includes('css/styles.css') && !srcPath.endsWith('.js') && !srcPath.endsWith('.tsx')) {
        // Copy file (skip styles.css as it's already processed and skip TypeScript files as they should be compiled)
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  // Copy each asset subdirectory to the root of dist (excluding already processed CSS and TypeScript)
  const assetsDir = path.join(rootDir, 'src/assets/')
  if (fs.existsSync(assetsDir)) {
    const assetDirs = fs.readdirSync(assetsDir, { withFileTypes: true })
    assetDirs.forEach(dir => {
      if (dir.isDirectory()) {
        const srcPath = path.join(assetsDir, dir.name)

        // Special handling for HTML files - copy them to dist root
        if (dir.name === 'html') {
          const htmlFiles = fs.readdirSync(srcPath).filter(file => file.endsWith('.html'))
          htmlFiles.forEach(htmlFile => {
            fs.copyFileSync(
              path.join(srcPath, htmlFile),
              path.join(distDir, htmlFile)
            )
          })
        } else {
          // Copy other asset directories normally
          const destPath = path.join(distDir, dir.name)
          copyDirRecursive(srcPath, destPath)
        }
      }
    })
  }

  logger.log('Copied asset files to dist directory')
}

// Create packaged extension files
const createPackage = async () => {
  const archiver = (await import('archiver')).default
  const ChromeExtension = (await import('crx')).default

  // Create builds directory if it doesn't exist
  const buildsDir = path.join(rootDir, 'builds')
  if (!fs.existsSync(buildsDir)) {
    fs.mkdirSync(buildsDir, { recursive: true })
  }

  // Read package.json to get version
  const packagePath = path.resolve(rootDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const version = packageJson.version

  const zipPath = path.join(buildsDir, `polly-for-chrome-v${version}.zip`)
  const crxPath = path.join(buildsDir, `polly-for-chrome-v${version}.crx`)

  try {
    // Step 1: Create a zip file
    await new Promise((resolve, reject) => {
      logger.log('Creating extension zip file...')
      const output = fs.createWriteStream(zipPath)
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      })

      output.on('close', () => {
        logger.log(`Extension zip created: ${zipPath} (${archive.pointer()} bytes) (v${version})`)
        resolve()
      })

      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          logger.warn('Archive warning:', err)
        } else {
          reject(err)
        }
      })

      archive.on('error', reject)

      archive.pipe(output)
      archive.directory(distDir, false)
      archive.finalize()
    })

    // Step 2: Create a CRX file if a key is available
    const keyPath = path.join(rootDir, 'key.pem')
    if (fs.existsSync(keyPath)) {
      logger.log('Creating CRX package...')
      const crx = new ChromeExtension({
        privateKey: fs.readFileSync(keyPath)
      })

      try {
        await crx.load(distDir)
        const crxBuffer = await crx.pack()

        fs.writeFileSync(crxPath, crxBuffer)
        logger.log(`CRX package created: ${crxPath} (v${version})`)
      } catch (crxErr) {
        logger.error('Error creating CRX package:', crxErr)
      }
    } else {
      logger.log('No private key found at key.pem. Skipping CRX creation.')
      logger.log('To create a CRX file, generate a private key with:')
      logger.log('openssl genrsa -out key.pem 2048')
    }
  } catch (error) {
    logger.error('Error creating extension packages:', error)
  }
}

// Run build process
async function build() {
  // Generate icons first
  await generateIcons()

  // Copy manifest, and assets
  await copyManifest()
  await copyAssets()


  // Copy YAML files for localization
  const copyYamlFiles = () => {
    const yamlSourceDir = path.join(rootDir, 'src/localization')

    // Skip if localization directory doesn't exist
    if (!fs.existsSync(yamlSourceDir)) {
      logger.log('Skipped YAML localization files (directory not found)')
      return
    }
    
    const yamlDestDir = path.join(distDir, 'localization')

    // Create destination directory if it doesn't exist
    if (!fs.existsSync(yamlDestDir)) {
      fs.mkdirSync(yamlDestDir, { recursive: true })
    }

    // Find all YAML files
    const yamlFiles = fs.readdirSync(yamlSourceDir).filter(file => file.endsWith('.yaml'))

    // Copy each file
    yamlFiles.forEach(file => {
      fs.copyFileSync(
        path.join(yamlSourceDir, file),
        path.join(yamlDestDir, file)
      )
    })

    logger.log('Copied YAML localization files to dist directory')
  }

  // Copy YAML files
  copyYamlFiles()

  try {
    const isWatchMode = process.argv.includes('--watch')

    // Define entry points
    const entryPoints = {
      'popup': path.join(rootDir, 'src/popup.tsx'),
      'service-worker': path.join(rootDir, 'src/service-worker.js'),
      'content-script': path.join(rootDir, 'src/content-script.tsx'),
      'help': path.join(rootDir, 'src/help.tsx'),
      'offscreen': path.join(rootDir, 'src/offscreen.js')
    }

    // Auto-discover TypeScript files in src/assets/js/
    const tsAssetsDir = path.join(rootDir, 'src/assets/js')
    if (fs.existsSync(tsAssetsDir)) {
      const tsFiles = fs.readdirSync(tsAssetsDir, { recursive: true })
        .filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))
        .map(file => {
          const fullPath = path.join(tsAssetsDir, file)
          const relativePath = path.relative(tsAssetsDir, fullPath)
          const name = 'js/' + relativePath.replace(/\.(ts|tsx)$/, '')
          return { name, path: fullPath }
        })

      // Add TypeScript assets to entry points
      tsFiles.forEach(({ name, path: filePath }) => {
        entryPoints[name] = filePath
      })
    }

    // Build options
    const buildOptions = {
      entrypoints: Object.values(entryPoints),
      outdir: distDir,
      target: 'browser',
      format: 'esm',
      sourcemap: 'external',
      minify: process.env.NODE_ENV === 'production',
      naming: {
        // Use the entry point name as-is (already includes proper path)
        entry: '[name].js'
      },
      plugins: [
        {
          name: 'react-compiler',
          setup(build) {
            // React Compiler plugin for processing TSX/JSX files
            build.onLoad({ filter: /\.(tsx|jsx)$/ }, async (args) => {
              // Skip node_modules
              if (args.path.includes('node_modules')) {
                return
              }

              try {
                const babel = (await import('@babel/core')).default
                const fs = (await import('fs')).default

                const source = fs.readFileSync(args.path, 'utf8')

                const result = await babel.transformAsync(source, {
                  filename: args.path,
                  presets: [
                    ['@babel/preset-react', { runtime: 'automatic' }],
                    '@babel/preset-typescript'
                  ],
                  plugins: [
                    ['babel-plugin-react-compiler', {
                      compilationMode: 'annotation'
                    }]
                  ]
                })

                return {
                  contents: result.code,
                  loader: 'tsx'
                }
              } catch (error) {
                console.warn(`React Compiler warning for ${args.path}:`, error.message)
                // Fall back to default processing if React Compiler fails
                return
              }
            })
          }
        },
        {
          name: 'yaml-loader',
          setup(build) {
            // Load .yaml files
            build.onLoad({ filter: /\.yaml$/ }, async (args) => {
              const jsYaml = (await import('js-yaml')).default
              const text = await Bun.file(args.path).text()
              const content = jsYaml.load(text)
              return {
                contents: `export default ${JSON.stringify(content)}`,
                loader: 'js'
              }
            })
          }
        }
      ]
    }

    // Initial build
    const result = await Bun.build(buildOptions)
    logger.log('Build completed successfully')

    // Create packaged extension files
    await createPackage()

    if (isWatchMode) {
      logger.log('Watching for changes...')

      // Watch src directory for TS/JS/YAML changes
      watch(path.join(rootDir, 'src'), { recursive: true }, async (eventType, filename) => {
        if (filename && (filename.endsWith('.js') || filename.endsWith('.js') || filename.endsWith('.yaml'))) {
          logger.log(`Change detected in ${filename}, rebuilding...`)
          try {
            await Bun.build(buildOptions)
            logger.log('Rebuild completed')
            // Create updated extension packages
            await createPackage()
          } catch (error) {
            logger.error('Rebuild failed:', error)
          }
        }
      })

      // Watch HTML files
      watch(path.join(rootDir, 'src/assets/html'), { recursive: true }, async (eventType, filename) => {
        if (filename && filename.endsWith('.html')) {
          logger.log(`Change detected in ${filename}`)
          await createPackage()
        }
      })

      // Watch manifest.js
      watch(path.join(rootDir, 'manifest.js'), async () => {
        logger.log('Change detected in manifest.js')
        await copyManifest()
        await createPackage()
      })

      // Watch CSS files
      watch(path.join(rootDir, 'src/assets/css'), { recursive: true }, async () => {
        logger.log('Change detected in CSS files')
        await copyAssets()
        await createPackage()
      })

      // Watch asset files (images, etc.)
      watch(path.join(rootDir, 'src/assets'), { recursive: true }, async (eventType, filename) => {
        if (filename && !filename.includes('css/styles.css') && !filename.endsWith('.ts') && !filename.endsWith('.tsx')) {
          logger.log(`Change detected in asset files: ${filename}`)
          await copyAssets()
          await createPackage()
        }
      })

      // Watch YAML localization files (only if directory exists)
      const localizationDir = path.join(rootDir, 'src/localization')
      if (fs.existsSync(localizationDir)) {
        watch(localizationDir, { recursive: true }, async (eventType, filename) => {
          if (filename && filename.endsWith('.yaml')) {
            logger.log('Change detected in YAML localization files')
            copyYamlFiles()
            await createPackage()
          }
        })
      }

      // Keep process running
      setInterval(() => {
      }, 1000)
    }
  } catch (err) {
    logger.error('Build failed:', err)
    process.exit(1)
  }
}

build()