const webpack = require('webpack')
const path = require('path')
const { CleanWebpackPlugin } = require('clean-webpack-plugin')
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = {
  entry: {
    app: path.join(__dirname, 'src', 'index.tsx')
  }, 
  output: {
    filename: '[name].[contenthash].js',
    path: path.resolve(__dirname, 'dist')
  },
  plugins: [
    new CleanWebpackPlugin(),
    new HtmlWebpackPlugin({
      filename: 'index.html',
      inject: true,
      template: path.join(__dirname, 'public', 'index.html'),
      favicon: path.join(__dirname, 'public', 'favicon.ico')
    }),
    new webpack.ProvidePlugin({
      process: 'process/browser',
    }),
    new webpack.HotModuleReplacementPlugin(),
    new webpack.ProgressPlugin(),
  ],
  resolve: {
    extensions: ['.ts', '.tsx', '.js']
  },
  module: {
      rules: [
          {
              test: /\.(ts)x?$/,
              use: 'ts-loader',
              exclude: '/node_modules/'
          },
          {
            test: /\.(png|jpe?g|gif)$/i,
            use: ['file-loader'],
          },
      ],
  },
}
