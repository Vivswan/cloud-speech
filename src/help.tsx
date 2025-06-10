import React from 'react'
import { createRoot } from 'react-dom/client'

function Help() {
  return (
    <div className="flex justify-center bg-neutral-50 bg-opacity-30">
      <div className="flex flex-col items-center justify-center w-full max-w-4xl p-8">
        <div className="flex flex-col justify-center gap-6 pt-8">
          <div className="flex justify-center">
            <div className="flex items-center text-center">
              <img
                src="assets/images/icon_1000.png"
                className="mr-4 pt-0.5"
                style={{ width: '64px' }}
              />
              <div>
                <div className="text-4xl font-bold text-neutral-800">
                  Polly for Chrome
                </div>
                <div
                  className="text-2xl font-bold text-neutral-500"
                  style={{ marginTop: '-5px' }}
                >
                  Help Guide
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="w-full max-w-4xl p-6 space-y-8">

          {/* Getting Started */}
          <Section
            title="🚀 Getting Started"
            content={
              <div className="space-y-4">
                <p className="text-gray-700">
                  Polly for Chrome converts highlighted text into natural-sounding speech using Amazon Polly.
                  To get started, you'll need to set up AWS credentials.
                </p>
                <div className="bg-blue-50 border-l-4 border-blue-400 p-4">
                  <p className="text-blue-800 font-semibold">💡 Prerequisites</p>
                  <ul className="list-disc list-inside text-blue-700 mt-2 space-y-1">
                    <li>An AWS account (free tier available)</li>
                    <li>Basic understanding of AWS IAM (we'll guide you)</li>
                  </ul>
                </div>
              </div>
            }
          />

          {/* AWS Setup */}
          <Section
            title="🔑 Setting Up AWS Credentials"
            content={
              <div className="space-y-6">
                <Step
                  number="1"
                  title="Create an AWS Account"
                  content={
                    <div>
                      <p>If you don't have an AWS account:</p>
                      <ol className="list-decimal list-inside mt-2 space-y-1">
                        <li>Go to <a href="https://aws.amazon.com" target="_blank"
                                     className="text-blue-600 hover:underline">aws.amazon.com</a></li>
                        <li>Click "Create an AWS Account"</li>
                        <li>Follow the registration process</li>
                        <li>Add a payment method (free tier covers basic usage)</li>
                      </ol>
                    </div>
                  }
                />

                <Step
                  number="2"
                  title="Create an IAM User"
                  content={
                    <div>
                      <p>For security, create a dedicated user for Polly access:</p>
                      <ol className="list-decimal list-inside mt-2 space-y-1">
                        <li>Sign in to AWS Console</li>
                        <li>Go to <strong>IAM</strong> service</li>
                        <li>Click <strong>Users</strong> → <strong>Create user</strong></li>
                        <li>Enter username (e.g., "polly-chrome-extension")</li>
                        <li>Select <strong>"Attach policies directly"</strong></li>
                        <li>Search and select <strong>"AmazonPollyReadOnlyAccess"</strong></li>
                        <li>Click <strong>Create user</strong></li>
                      </ol>
                    </div>
                  }
                />

                <Step
                  number="3"
                  title="Generate Access Keys"
                  content={
                    <div>
                      <p>Create access keys for the extension:</p>
                      <ol className="list-decimal list-inside mt-2 space-y-1">
                        <li>Click on your newly created user</li>
                        <li>Go to <strong>Security credentials</strong> tab</li>
                        <li>Click <strong>Create access key</strong></li>
                        <li>Select <strong>"Application running outside AWS"</strong></li>
                        <li>Add description: "Polly Chrome Extension"</li>
                        <li>Click <strong>Create access key</strong></li>
                        <li><strong>Important:</strong> Copy both the Access Key ID and Secret Access Key</li>
                      </ol>
                      <div className="bg-red-50 border-l-4 border-red-400 p-4 mt-4">
                        <p className="text-red-800 font-semibold">⚠️ Security Warning</p>
                        <p className="text-red-700 mt-1">
                          Save your Secret Access Key immediately. AWS will never show it again.
                          Keep these credentials secure and never share them.
                        </p>
                      </div>
                    </div>
                  }
                />

                <Step
                  number="4"
                  title="Choose Your Region"
                  content={
                    <div>
                      <p>Select the AWS region closest to you for better performance:</p>
                      <div className="grid grid-cols-2 gap-4 mt-4">
                        <div>
                          <strong>Popular Regions:</strong>
                          <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
                            <li><code>us-east-1</code> - N. Virginia (cheapest)</li>
                            <li><code>us-west-2</code> - Oregon</li>
                            <li><code>eu-west-1</code> - Ireland</li>
                            <li><code>ap-southeast-1</code> - Singapore</li>
                          </ul>
                        </div>
                        <div>
                          <strong>All Regions:</strong>
                          <p className="text-sm mt-2">
                            See <a href="https://docs.aws.amazon.com/general/latest/gr/pol.html" target="_blank"
                                   className="text-blue-600 hover:underline">AWS Polly regions</a> for complete list
                          </p>
                        </div>
                      </div>
                    </div>
                  }
                />
              </div>
            }
          />

          {/* Extension Setup */}
          <Section
            title="⚙️ Configuring the Extension"
            content={
              <div className="space-y-4">
                <Step
                  number="1"
                  title="Enter Your Credentials"
                  content={
                    <div>
                      <ol className="list-decimal list-inside space-y-1">
                        <li>Click the Polly extension icon in your browser</li>
                        <li>Enter your <strong>Access Key ID</strong></li>
                        <li>Enter your <strong>Secret Access Key</strong></li>
                        <li>Enter your chosen <strong>Region</strong> (e.g., us-east-1)</li>
                        <li>Click <strong>Validate credentials</strong></li>
                      </ol>
                    </div>
                  }
                />

                <Step
                  number="2"
                  title="Customize Settings"
                  content={
                    <div>
                      <p>Once credentials are validated, customize your experience:</p>
                      <ul className="list-disc list-inside mt-2 space-y-1">
                        <li><strong>Language:</strong> Choose from 40+ languages</li>
                        <li><strong>Engine:</strong> Select voice quality (Standard, Neural, Generative, Long-form)</li>
                        <li><strong>Voice:</strong> Select from hundreds of natural voices (filtered by language and
                          engine)
                        </li>
                        <li><strong>Speed:</strong> Adjust playback speed (0.5x to 3x)</li>
                        <li><strong>Pitch:</strong> Modify voice pitch (-10 to +10)</li>
                        <li><strong>Volume:</strong> Control audio volume (-16dB to +16dB)</li>
                      </ul>
                    </div>
                  }
                />
              </div>
            }
          />

          {/* Usage Guide */}
          <Section
            title="📖 How to Use"
            content={
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h4 className="font-semibold text-lg mb-3">🖱️ Using Context Menu</h4>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Highlight any text on a webpage</li>
                      <li>Right-click on the selected text</li>
                      <li>Choose "Read aloud" or "Download MP3"</li>
                    </ol>
                  </div>
                  <div>
                    <h4 className="font-semibold text-lg mb-3">⌨️ Using Keyboard Shortcuts</h4>
                    <ul className="space-y-2">
                      <li><kbd className="px-2 py-1 bg-gray-200 rounded">Ctrl+Shift+S</kbd> - Read aloud</li>
                      <li><kbd className="px-2 py-1 bg-gray-200 rounded">Ctrl+Shift+E</kbd> - Download</li>
                      <li className="text-sm text-gray-600">On Mac: Use Cmd instead of Ctrl</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-green-50 border-l-4 border-green-400 p-4">
                  <p className="text-green-800 font-semibold">✨ Pro Tips</p>
                  <ul className="list-disc list-inside text-green-700 mt-2 space-y-1">
                    <li>Works with any text on any website</li>
                    <li>Supports SSML markup for advanced control</li>
                    <li>Automatically breaks long text into sentences</li>
                    <li>Downloaded files are saved as high-quality MP3</li>
                  </ul>
                </div>
              </div>
            }
          />

          {/* Features */}
          <Section
            title="🎵 Audio Features"
            content={
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h4 className="font-semibold mb-2">📥 Download Formats</h4>
                    <ul className="space-y-1">
                      <li><strong>MP3 (64kbps):</strong> Recommended quality</li>
                      <li><strong>MP3 (32kbps):</strong> Smaller file size</li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">🔊 Playback Formats</h4>
                    <ul className="space-y-1">
                      <li><strong>OGG:</strong> Best compression (recommended)</li>
                      <li><strong>WAV:</strong> Uncompressed quality</li>
                      <li><strong>MP3:</strong> Universal compatibility</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h4 className="font-semibold mb-2">🎯 SSML Support</h4>
                  <p className="mb-2">Use Speech Synthesis Markup Language for advanced control:</p>
                  <div className="bg-gray-100 p-3 rounded font-mono text-sm">
                    &lt;speak&gt;<br />
                    &nbsp;&nbsp;Hello &lt;break time="1s"/&gt; world!<br />
                    &nbsp;&nbsp;&lt;prosody rate="slow"&gt;This is slow&lt;/prosody&gt;<br />
                    &lt;/speak&gt;
                  </div>
                  <p className="text-sm text-gray-600 mt-2">
                    Learn more: <a href="https://docs.aws.amazon.com/polly/latest/dg/ssml.html" target="_blank"
                                   className="text-blue-600 hover:underline">AWS SSML Documentation</a>
                  </p>
                </div>
              </div>
            }
          />

          {/* Pricing */}
          <Section
            title="💰 Pricing & Usage"
            content={
              <div className="space-y-4">
                <div className="bg-blue-50 border-l-4 border-blue-400 p-4">
                  <p className="text-blue-800 font-semibold">💝 AWS Free Tier</p>
                  <p className="text-blue-700 mt-1">
                    Amazon Polly includes 5 million characters per month free for the first 12 months.
                  </p>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h4 className="font-semibold mb-2">Standard Voices</h4>
                    <ul className="space-y-1 text-sm">
                      <li>$4.00 per 1 million characters</li>
                      <li>$0.000004 per character</li>
                      <li>Basic quality, cost-effective</li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">Neural Voices</h4>
                    <ul className="space-y-1 text-sm">
                      <li>$16.00 per 1 million characters</li>
                      <li>$0.000016 per character</li>
                      <li>Higher quality, more natural</li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">Generative Voices</h4>
                    <ul className="space-y-1 text-sm">
                      <li>$30.00 per 1 million characters</li>
                      <li>$0.000030 per character</li>
                      <li>Most natural, latest technology</li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">Long-form Voices</h4>
                    <ul className="space-y-1 text-sm">
                      <li>$100.00 per 1 million characters</li>
                      <li>$0.000100 per character</li>
                      <li>Optimized for long content</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4">
                  <p className="text-yellow-800 font-semibold">💡 Cost Optimization</p>
                  <ul className="list-disc list-inside text-yellow-700 mt-2 space-y-1">
                    <li>Use standard voices for most content</li>
                    <li>Reserve neural voices for important audio</li>
                    <li>Use generative/long-form voices sparingly due to higher cost</li>
                    <li>Monitor usage in AWS Console</li>
                    <li>Set up billing alerts</li>
                  </ul>
                </div>

                <p className="text-sm text-gray-600">
                  Current pricing: <a href="https://aws.amazon.com/polly/pricing/" target="_blank"
                                      className="text-blue-600 hover:underline">AWS Polly Pricing</a>
                </p>
              </div>
            }
          />

          {/* Troubleshooting */}
          <Section
            title="🔧 Troubleshooting"
            content={
              <div className="space-y-4">
                <TroubleshootItem
                  problem="❌ 'AWS credentials are missing or invalid'"
                  solution={
                    <ul className="list-disc list-inside space-y-1">
                      <li>Double-check your Access Key ID and Secret Access Key</li>
                      <li>Ensure your IAM user has AmazonPollyReadOnlyAccess policy</li>
                      <li>Verify your region is correct (e.g., us-east-1)</li>
                      <li>Check if your access keys are active in AWS Console</li>
                    </ul>
                  }
                />

                <TroubleshootItem
                  problem="🔇 No audio plays"
                  solution={
                    <ul className="list-disc list-inside space-y-1">
                      <li>Check your browser's audio settings</li>
                      <li>Ensure the browser tab has audio permission</li>
                      <li>Try a different audio format (OGG → MP3)</li>
                      <li>Check if other audio works in your browser</li>
                    </ul>
                  }
                />

                <TroubleshootItem
                  problem="🚫 'Access Denied' errors"
                  solution={
                    <ul className="list-disc list-inside space-y-1">
                      <li>Your IAM user needs AmazonPollyReadOnlyAccess permission</li>
                      <li>Check if Polly is available in your selected region</li>
                      <li>Verify your AWS account is in good standing</li>
                      <li>Ensure you haven't exceeded service limits</li>
                    </ul>
                  }
                />

                <TroubleshootItem
                  problem="💸 Unexpected charges"
                  solution={
                    <ul className="list-disc list-inside space-y-1">
                      <li>Monitor usage in AWS Console → Polly → Usage reports</li>
                      <li>Set up billing alerts in AWS Billing Dashboard</li>
                      <li>Neural voices cost 4x more than standard voices</li>
                      <li>Each character (including spaces) counts toward usage</li>
                    </ul>
                  }
                />
              </div>
            }
          />

          {/* Support */}
          <Section
            title="🆘 Getting Help"
            content={
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h4 className="font-semibold mb-2">Extension Issues</h4>
                    <ul className="space-y-2">
                      <li>
                        <a href="https://github.com/vivswan/polly-for-chrome/issues" target="_blank"
                           className="text-blue-600 hover:underline">
                          🐛 Report bugs on GitHub
                        </a>
                      </li>
                      <li>
                        <a href="https://github.com/vivswan/polly-for-chrome" target="_blank"
                           className="text-blue-600 hover:underline">
                          📖 View source code
                        </a>
                      </li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">AWS Support</h4>
                    <ul className="space-y-2">
                      <li>
                        <a href="https://docs.aws.amazon.com/polly/" target="_blank"
                           className="text-blue-600 hover:underline">
                          📚 AWS Polly Documentation
                        </a>
                      </li>
                      <li>
                        <a href="https://aws.amazon.com/support/" target="_blank"
                           className="text-blue-600 hover:underline">
                          💬 AWS Support Center
                        </a>
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="bg-gray-50 border-l-4 border-gray-400 p-4">
                  <p className="text-gray-800 font-semibold">🤝 Community</p>
                  <p className="text-gray-700 mt-1">
                    Join discussions, share tips, and get help from other users in our GitHub community.
                  </p>
                </div>
              </div>
            }
          />

        </div>
      </div>
    </div>
  )
}

// Helper Components
function Section({ title, content }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-4">{title}</h2>
      {content}
    </div>
  )
}

function Step({ number, title, content }) {
  return (
    <div className="flex gap-4">
      <div
        className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-bold">
        {number}
      </div>
      <div className="flex-grow">
        <h4 className="font-semibold text-lg mb-2">{title}</h4>
        <div className="text-gray-700">{content}</div>
      </div>
    </div>
  )
}

function TroubleshootItem({ problem, solution }) {
  return (
    <div className="border-l-4 border-orange-400 bg-orange-50 p-4">
      <h4 className="font-semibold text-orange-800 mb-2">{problem}</h4>
      <div className="text-orange-700">{solution}</div>
    </div>
  )
}

const root = document.createElement('div')
root.id = 'help-root'

document.body.appendChild(root)

createRoot(root).render(<Help />)