//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import hsts from 'hsts';

export default hsts({
  maxAge: 31536000, // 1 year in seconds
  includeSubDomains: true, // Must be enabled to be approved
  preload: true,
});
