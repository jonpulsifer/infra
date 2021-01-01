const path = require('path')
const { merge } = require('webpack-merge')
const commonConfig = require('./webpack.config.common')

module.exports = merge(commonConfig, {
  mode: 'development',
  devtool: 'inline-source-map',
  devServer: {
    contentBase: path.resolve(__dirname, 'dist'),
    host: '0.0.0.0',
    port: 8080,
    allowedHosts: [
      'hub.home.pulsifer.ca',
      'hub.myshopify.io',
      'nuc',
      'localhost',
    ],
    hot: true,
    watchContentBase: true,
    historyApiFallback: true
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
    ]
  }
})
