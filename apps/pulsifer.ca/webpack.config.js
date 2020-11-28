const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: 'none',
  entry: {
      app: path.join(__dirname, 'src', 'index.tsx')
  },
  target: 'web',
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
            test: /\.css$/,
            use: ['style-loader', 'css-loader'],
          },
          {
            test: /\.(png|jpe?g|gif)$/i,
            use: ['file-loader'],
          },
      ],
  },
  output: {
      filename: '[name].js',
      path: path.resolve(__dirname, 'build'),
  },
  devServer: {
    contentBase: path.resolve('src'),
    host: '0.0.0.0',
    port: 8080,
    allowedHosts: [
      'pulsifer.myshopify.io',
    ],
    hot: true,
    watchContentBase: true,
    historyApiFallback: true
  },
  plugins: [
      new webpack.HotModuleReplacementPlugin(),
      new HtmlWebpackPlugin({
          template: path.join(__dirname, 'public', 'index.html'),
          favicon: path.join(__dirname, 'public', 'favicon.ico')
      })
  ]
};
