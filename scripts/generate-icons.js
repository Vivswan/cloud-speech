const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

// Paths
const rootDir = path.join(__dirname, '..')
const svgPath = path.join(rootDir, 'src/assets/images/icon.svg')
const distOutputDir = path.join(rootDir, 'dist/assets/images')

// Icon sizes to generate
const sizes = [16, 48, 128]

// Generate each size directly to dist
async function generateIcons() {
  console.log('Generating PNG icons from SVG...')

  // Check if SVG exists
  if (!fs.existsSync(svgPath)) {
    console.error(`Error: SVG file not found at ${svgPath}`)
    throw new Error('SVG file not found')
  }

  // Read the SVG file
  const svgBuffer = fs.readFileSync(svgPath)

  // Make sure the dist directory exists
  if (!fs.existsSync(path.join(rootDir, 'dist'))) {
    fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true })
  }

  // Make sure the images directory exists
  if (!fs.existsSync(distOutputDir)) {
    fs.mkdirSync(distOutputDir, { recursive: true })
  }

  // Also copy the SVG to dist
  fs.copyFileSync(svgPath, path.join(distOutputDir, 'icon.svg'))
  console.log('Copied icon.svg to dist directory')

  // Generate all icons
  const promises = sizes.map(size => {
    const outputPath = path.join(distOutputDir, `icon${size}.png`)
    return sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath)
      .then(() => {
        console.log(`Successfully generated icon${size}.png in dist directory`)
      })
      .catch(error => {
        console.error(`Failed to generate icon${size}.png: ${error.message}`)
      })
  })

  await Promise.all(promises)
  console.log('Icon generation complete!')
}

// If script is run directly
if (require.main === module) {
  generateIcons().catch(err => {
    console.error('Error generating icons:', err)
    process.exit(1)
  })
}

// Export the function for use as a module
module.exports = generateIcons