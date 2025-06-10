import path from 'path'
import fs, { watch } from 'fs'
import { fileURLToPath } from 'url'
import generateIconsModule from './generate-icons.js'

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
    console.log('Generating icons...')
    await generateIconsModule()
    console.log('Icons generated successfully')
  } catch (error) {
    console.error('Error generating icons:', error.message)
  }
}

// HTML template processing
const processHTML = () => {
  let htmlContent = fs.readFileSync(path.join(rootDir, 'src/assets/html/popup.html'), 'utf8')

  // Add script tags to HTML before closing body tag
//   htmlContent = htmlContent.replace('</body>', `
//   <!-- Initialization script -->
//   <script src="init.js"></script>
//
//   <!-- Main script bundle -->
//   <script src="index.js"></script>
// </body>`)

  fs.writeFileSync(path.join(distDir, 'popup.html'), htmlContent)
  console.log('Processed popup.html')
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
  console.log(`Updated manifest.json with version ${packageJson.version} and copied to dist directory`)
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
          to: path.join(distDir, 'assets/css/styles.css')
        })

      // Ensure CSS directory exists
      const cssDir = path.join(distDir, 'assets/css')
      if (!fs.existsSync(cssDir)) {
        fs.mkdirSync(cssDir, { recursive: true })
      }

      fs.writeFileSync(path.join(distDir, 'assets/css/styles.css'), result.css)
      console.log('Processed Tailwind CSS')
    } catch (error) {
      console.error('Error processing Tailwind CSS:', error)
      // Fallback: copy CSS file as-is
      const cssDir = path.join(distDir, 'assets/css')
      if (!fs.existsSync(cssDir)) {
        fs.mkdirSync(cssDir, { recursive: true })
      }
      fs.copyFileSync(
        path.join(rootDir, 'src/assets/css/styles.css'),
        path.join(distDir, 'assets/css/styles.css')
      )
      console.log('Copied CSS file without processing (Tailwind processing failed)')
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
      } else if (!srcPath.includes('css/styles.css')) {
        // Copy file (skip styles.css as it's already processed)
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  // Copy images and other assets (excluding the already processed CSS)
  copyDirRecursive(
    path.join(rootDir, 'src/assets/'),
    path.join(distDir, 'assets/')
  )

  console.log('Copied asset files to dist directory')
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

  const zipPath = path.join(buildsDir, `foundation-fill-v${version}.zip`)
  const crxPath = path.join(buildsDir, `foundation-fill-v${version}.crx`)

  try {
    // Step 1: Create a zip file
    await new Promise((resolve, reject) => {
      console.log('Creating extension zip file...')
      const output = fs.createWriteStream(zipPath)
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      })

      output.on('close', () => {
        console.log(`Extension zip created: ${zipPath} (${archive.pointer()} bytes) (v${version})`)
        resolve()
      })

      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          console.warn('Archive warning:', err)
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
      console.log('Creating CRX package...')
      const crx = new ChromeExtension({
        privateKey: fs.readFileSync(keyPath)
      })

      try {
        await crx.load(distDir)
        const crxBuffer = await crx.pack()

        fs.writeFileSync(crxPath, crxBuffer)
        console.log(`CRX package created: ${crxPath} (v${version})`)
      } catch (crxErr) {
        console.error('Error creating CRX package:', crxErr)
      }
    } else {
      console.log('No private key found at key.pem. Skipping CRX creation.')
      console.log('To create a CRX file, generate a private key with:')
      console.log('openssl genrsa -out key.pem 2048')
    }
  } catch (error) {
    console.error('Error creating extension packages:', error)
  }
}

// Run build process
async function build() {
  // Generate icons first
  await generateIcons()

  // Process HTML, manifest, and assets
  processHTML()
  await copyManifest()
  await copyAssets()

  // Copy help.html if it exists
  const helpHtmlPath = path.join(rootDir, 'src/assets/html/help.html')
  if (fs.existsSync(helpHtmlPath)) {
    fs.copyFileSync(helpHtmlPath, path.join(distDir, 'help.html'))
    console.log('Copied help.html to dist directory')
  }

  // Copy YAML files for localization
  const copyYamlFiles = () => {
    const yamlSourceDir = path.join(rootDir, 'src/localization')

    // Skip if localization directory doesn't exist
    if (!fs.existsSync(yamlSourceDir)) {
      console.log('Skipped YAML localization files (directory not found)')
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

    console.log('Copied YAML localization files to dist directory')
  }

  // Copy YAML files
  copyYamlFiles()

  try {
    const isWatchMode = process.argv.includes('--watch')

    // Define entry points
    const entryPoints = {
      'popup': path.join(rootDir, 'src/popup.tsx'),
      'service-worker': path.join(rootDir, 'src/service-worker.ts'),
      'content-script': path.join(rootDir, 'src/content-script.tsx'),
      'help': path.join(rootDir, 'src/help.tsx'),
      'offscreen': path.join(rootDir, 'src/offscreen.ts')
    }

    // Build options
    const buildOptions = {
      entrypoints: [
        entryPoints['popup'],
        entryPoints['service-worker'],
        entryPoints['content-script'],
        entryPoints['help'],
        entryPoints['offscreen']
      ],
      outdir: distDir,
      target: 'browser',
      format: 'esm',
      sourcemap: 'external',
      minify: process.env.NODE_ENV === 'production',
      naming: {
        // Prevent files from being put in subdirectories
        // Use flat structure in root output directory
        entry: '[name].js'
      },
      plugins: [
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
    console.log('Build completed successfully')

    // Create packaged extension files
    await createPackage()

    if (isWatchMode) {
      console.log('Watching for changes...')

      // Watch src directory for TS/JS/YAML changes
      watch(path.join(rootDir, 'src'), { recursive: true }, async (eventType, filename) => {
        if (filename && (filename.endsWith('.ts') || filename.endsWith('.js') || filename.endsWith('.yaml'))) {
          console.log(`Change detected in ${filename}, rebuilding...`)
          try {
            await Bun.build(buildOptions)
            console.log('Rebuild completed')
            // Create updated extension packages
            await createPackage()
          } catch (error) {
            console.error('Rebuild failed:', error)
          }
        }
      })

      // Watch HTML files
      watch(path.join(rootDir, 'src'), { recursive: true }, async (eventType, filename) => {
        if (filename && filename.endsWith('.html')) {
          console.log(`Change detected in ${filename}`)

          if (filename === 'popup.html' || filename.includes('popup.html')) {
            processHTML()
          } else {
            // Copy other HTML files directly
            const srcPath = path.join(rootDir, 'src', filename)
            const destPath = path.join(distDir, filename)

            // Ensure the destination directory exists
            const destDir = path.dirname(destPath)
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true })
            }

            fs.copyFileSync(srcPath, destPath)
            console.log(`Copied ${filename} to dist directory`)
          }

          await createPackage()
        }
      })

      // Watch manifest.js
      watch(path.join(rootDir, 'manifest.js'), async () => {
        console.log('Change detected in manifest.js')
        await copyManifest()
        await createPackage()
      })

      // Watch CSS files
      watch(path.join(rootDir, 'src/assets/css'), { recursive: true }, async () => {
        console.log('Change detected in CSS files')
        await copyAssets()
        await createPackage()
      })

      // Watch image files
      watch(path.join(rootDir, 'src/assets/images'), { recursive: true }, async () => {
        console.log('Change detected in image files')
        await copyAssets()
        await createPackage()
      })

      // Watch YAML localization files (only if directory exists)
      const localizationDir = path.join(rootDir, 'src/localization')
      if (fs.existsSync(localizationDir)) {
        watch(localizationDir, { recursive: true }, async (eventType, filename) => {
          if (filename && filename.endsWith('.yaml')) {
            console.log('Change detected in YAML localization files')
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
    console.error('Build failed:', err)
    process.exit(1)
  }
}

build()